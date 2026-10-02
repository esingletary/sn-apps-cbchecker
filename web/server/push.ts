import Ably from "ably";

// Chaturbate's own realtime push (Ably, on their domain), as the room page
// uses it. One anonymous connection carries status, title and tip events for
// every saved room, so changes land the moment they happen instead of on the
// next poll. Undocumented: the poller keeps running (slower) as a fallback.
//
// Flow: a csrftoken cookie from the home page → POST /push_service/auth/ with
// the topics we want per room (keyed by the room's broadcaster uid) → a token
// plus the Ably channel name for each topic → subscribe. Channel names carry a
// per-room shard suffix ("room:grouped:<uid>:17"), so always take them from
// the auth response rather than building them.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TOPICS = ["RoomStatusTopic", "RoomTitleChangeTopic", "RoomTipAlertTopic"];
// Room list changes arrive in bursts: on first run every room's uid is learned
// one poll at a time, seconds apart. Wait for a lull so that's one auth call,
// not one per room.
const RESUBSCRIBE_DEBOUNCE_MS = 30_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
// Polls that catch a status change push never delivered. This many within
// the window means the connection is up but not working: rebuild it.
const MISS_LIMIT = 3;
const MISS_WINDOW_MS = 30 * 60_000;

export interface Tip {
  amount: number;
  from: string | null; // null when anonymous
  message: string;
}

export interface PushHandlers {
  // `message` explains some statuses, e.g. "ClassicTicket\n\nHidden Cam show in progress."
  status(uid: string, status: string, message: string): void;
  title(uid: string, title: string): void;
  tip(uid: string, tip: Tip): void;
}

interface AuthResponse {
  token: string;
  channels: Record<string, string>;
  failures: Record<string, unknown>;
  settings: { host: string; rest_host: string; fallback_hosts: string[] };
}

export class PushClient {
  private uids: string[] = [];
  private client: Ably.Realtime | null = null;
  private channelNames = "";
  private cookies: string | null = null;
  private csrf: string | null = null;
  private resubscribeTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = RETRY_MIN_MS;
  private stopped = false;
  private misses: number[] = [];
  // For /api/health.
  state = "idle";
  lastEventAt: string | null = null;
  rebuilds = 0;

  constructor(private handlers: PushHandlers) {}

  get connected(): boolean {
    return this.client?.connection.state === "connected";
  }

  // Rooms to follow. Reconnects (debounced) when the set changes.
  setRooms(uids: string[]): void {
    const next = [...new Set(uids)].sort();
    if (next.join() === this.uids.join()) return;
    this.uids = next;
    clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = setTimeout(() => this.connect(), RESUBSCRIBE_DEBOUNCE_MS);
  }

  // A poll found a status change that push never delivered. Usually a race;
  // several in a row means the connection is silently broken.
  reportMiss(username: string): void {
    if (!this.connected) return;
    const now = Date.now();
    this.misses = this.misses.filter((t) => now - t < MISS_WINDOW_MS);
    this.misses.push(now);
    console.warn(`push: missed a change for ${username} (${this.misses.length}/${MISS_LIMIT})`);
    if (this.misses.length >= MISS_LIMIT) {
      this.misses = [];
      this.rebuild("too many missed changes");
    }
  }

  private rebuild(reason: string): void {
    console.warn(`push: ${reason}; reconnecting`);
    this.rebuilds++;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.resubscribeTimer);
    clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
  }

  private async refreshCookies(): Promise<void> {
    const res = await fetch("https://chaturbate.com/", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
    const csrf = cookies.find((c) => c.startsWith("csrftoken="))?.slice("csrftoken=".length);
    if (!csrf) throw new Error(`no csrftoken from home page (HTTP ${res.status})`);
    this.cookies = cookies.join("; ");
    this.csrf = csrf;
  }

  private async auth(uids: string[]): Promise<AuthResponse> {
    if (!this.csrf) await this.refreshCookies();
    const topics: Record<string, object> = {};
    for (const uid of uids) {
      for (const t of TOPICS) topics[`${t}#${t}:${uid}`] = { broadcaster_uid: uid };
    }
    const form = new FormData();
    form.set("presence_id", "+" + Math.random().toString(36).slice(2, 13));
    form.set("topics", JSON.stringify(topics));
    form.set("backend", "a");
    form.set("csrfmiddlewaretoken", this.csrf!);
    const res = await fetch("https://chaturbate.com/push_service/auth/", {
      method: "POST",
      body: form,
      headers: {
        "User-Agent": UA,
        Cookie: this.cookies!,
        Referer: "https://chaturbate.com/",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403) {
      // Stale csrf cookie: fetch a new one next attempt.
      this.csrf = null;
      throw new Error("auth HTTP 403");
    }
    if (!res.ok) throw new Error(`auth HTTP ${res.status}`);
    const data = (await res.json()) as AuthResponse;
    if (!data.token || !data.channels) throw new Error("auth: unexpected response");
    if (Object.keys(data.failures ?? {}).length) {
      console.warn("push: some topics refused:", Object.keys(data.failures).join(", "));
    }
    return data;
  }

  // (Re)builds the connection for the current room set.
  private async connect(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
    const uids = this.uids;
    if (!uids.length) {
      this.state = "idle";
      return;
    }

    let auth: AuthResponse;
    try {
      this.state = "authenticating";
      auth = await this.auth(uids);
    } catch (err) {
      this.retry(`auth failed: ${(err as Error).message}`);
      return;
    }
    if (this.stopped || uids !== this.uids) return; // superseded meanwhile

    const channels = [...new Set(Object.values(auth.channels))];
    this.channelNames = channels.slice().sort().join();
    let firstToken: string | null = auth.token;
    const client = new Ably.Realtime({
      // Ably asks again before the token (24h) expires. A renewal that comes
      // back with different channels means a rebuild.
      authCallback: (_params, cb) => {
        if (firstToken) {
          cb(null, firstToken);
          firstToken = null;
          return;
        }
        this.auth(this.uids).then(
          (fresh) => {
            cb(null, fresh.token);
            const names = [...new Set(Object.values(fresh.channels))].sort().join();
            if (names !== this.channelNames) this.connect();
          },
          (err) => cb((err as Error).message, null)
        );
      },
      // Their realtime and REST hosts have always been the same name; an
      // FQDN endpoint serves both.
      endpoint: auth.settings.host,
      fallbackHosts: auth.settings.fallback_hosts,
      logLevel: 1, // errors only
    });
    this.client = client;

    client.connection.on((change) => {
      if (this.client !== client) return;
      this.state = change.current;
      if (change.current === "connected") {
        this.retryMs = RETRY_MIN_MS;
        this.misses = [];
        console.log(`push: connected, following ${uids.length} rooms`);
      } else if (change.current === "failed" || change.current === "suspended") {
        this.retry(`connection ${change.current}: ${change.reason?.message ?? ""}`);
      }
    });

    for (const name of channels) {
      // "room:grouped:<uid>:<shard>"; the global channel has no uid.
      const uid = name.split(":")[2] ?? "";
      const channel = client.channels.get(name);
      // Ably re-attaches detached/suspended channels itself; failed is final.
      channel.on("failed", (change) => {
        if (this.client === client) this.retry(`channel ${name} failed: ${change.reason?.message ?? ""}`);
      });
      channel.subscribe((msg) => {
        if (this.client !== client) return;
        this.lastEventAt = new Date().toISOString();
        let data: Record<string, unknown>;
        try {
          data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
        } catch {
          return;
        }
        this.dispatch(uid, data);
      });
    }
  }

  private dispatch(uid: string, data: Record<string, unknown>): void {
    switch (data._topic) {
      case "RoomStatusTopic":
        if (typeof data.status === "string") {
          this.handlers.status(uid, data.status, typeof data.message === "string" ? data.message : "");
        }
        break;
      case "RoomTitleChangeTopic":
        if (typeof data.title === "string") this.handlers.title(uid, data.title);
        break;
      case "RoomTipAlertTopic":
        if (typeof data.amount === "number") {
          this.handlers.tip(uid, {
            amount: data.amount,
            from: data.is_anonymous_tip || typeof data.from_username !== "string" ? null : data.from_username,
            message: typeof data.message === "string" ? data.message : "",
          });
        }
        break;
      case "GlobalPushServiceBackendChangeTopic":
        // Their push backend moved; follow it.
        this.rebuild("backend change announced");
        break;
      // Chat, notices, panel refreshes, presence, ...: not needed.
    }
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    console.warn(`push: ${reason}; retrying in ${this.retryMs / 1000}s (polling covers meanwhile)`);
    this.client?.close();
    this.client = null;
    this.state = "retrying";
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}
