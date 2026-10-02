import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { PushClient, type Tip } from "./push.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "rooms.json");
// Last known status per room, so a restart doesn't reset every card to
// "Checking…" and fire a burst of upstream requests. Disposable cache.
const STATUS_FILE = path.join(DATA_DIR, "status.json");

// Background checker tuning. Chaturbate rate-limits per IP (HTTP 429, no
// Retry-After or limit headers), so instead of polling in bursts we check one
// room at a time with an adaptive gap between requests: it doubles on a 429
// and creeps back down after a run of successes, settling just under
// whatever the limit is.
const TARGET_ROOM_INTERVAL_MS = 30_000; // no need to re-check a room faster
// While push is connected it delivers status changes; polling then only
// refreshes viewer counts/photos and backstops anything push misses.
const PUSH_ROOM_INTERVAL_MS = 3 * 60_000;
// A pushed status beats a poll for this long: the polled API can lag behind.
const PUSH_TRUST_MS = 90_000;
const START_GAP_MS = 4_000;
const MIN_GAP_MS = 2_000;
const MAX_GAP_MS = 60_000;
const RATE_LIMIT_PAUSE_MS = 30_000;
const SUCCESSES_BEFORE_SPEEDUP = 30;
const STATUS_SAVE_INTERVAL_MS = 60_000;

app.use(express.json());

// Types
interface Room {
  id: number;
  username: string;
  added_at: string;
  // Live history, persisted so it survives restarts. Written only on
  // live/not-live transitions, not every poll.
  live_since?: string | null;
  last_live_at?: string | null;
  // Upstream broadcaster uid; push topics are keyed by it. Learned from the
  // first status check.
  uid?: string;
}

interface RoomStatus {
  username: string;
  isLive: boolean;
  // Upstream room_status ("public", "private", "away", "hidden", "offline", ...)
  // plus our own: "not_found" (no such room), "error" (never checked
  // successfully), "unknown" (not checked yet).
  roomStatus: string;
  checkedAt: string | null;
  liveSince: string | null;
  lastLiveAt: string | null;
  // Room details from upstream. Viewers and start time are only meaningful
  // while live (offline responses carry stale ones from the last show).
  numViewers?: number | null;
  roomTitle?: string | null;
  startedAt?: string | null;
  // Profile photo. Upstream only sends it while live, so the last one seen is
  // kept for offline cards.
  avatarUrl?: string | null;
  // Why a room is hidden, e.g. "ClassicTicket\n\nHidden Cam show in progress."
  statusMessage?: string | null;
  // Tips in the last TIP_WINDOW_MS (not persisted), for the cards' activity hint.
  recentTips?: { at: number; amount: number }[];
}

type Check = Pick<
  RoomStatus,
  | "username"
  | "isLive"
  | "roomStatus"
  | "checkedAt"
  | "numViewers"
  | "roomTitle"
  | "startedAt"
  | "avatarUrl"
  | "statusMessage"
>;

// --- Storage -----------------------------------------------------------------
// Rooms live in memory; the file is only read at startup. A corrupt file is a
// hard error (the container crash-loops and says why) rather than being
// treated as empty — that used to let the next add overwrite the whole list.

function loadRooms(): Room[] {
  let raw: string;
  try {
    raw = readFileSync(DB_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${DB_FILE}: expected an array`);
  return parsed;
}

// Write to a temp file then rename over the original, so a crash mid-write
// (or a backup reading mid-write) never sees a truncated file.
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, file);
}

function saveRooms(): void {
  writeJsonAtomic(DB_FILE, rooms);
}

let rooms: Room[];
try {
  rooms = loadRooms();
} catch (err) {
  console.error(`FATAL: cannot read ${DB_FILE} — refusing to start so it isn't overwritten.`, err);
  process.exit(1);
}

// --- Username handling -------------------------------------------------------

const USERNAME_RE = /^[a-z0-9_]{1,64}$/;

// Accepts a bare username or a pasted room URL ("https://chaturbate.com/foo/").
// Returns null if the result isn't a plausible username.
function normalizeUsername(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?chaturbate\.com\//, "")
    .replace(/\/+$/, "");
  return USERNAME_RE.test(name) ? name : null;
}

// --- Upstream status checks --------------------------------------------------

class RateLimitedError extends Error {
  constructor(public retryAfterMs: number | null) {
    super("rate limited");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns a fresh status (plus the tokenised HLS URL when live), or throws on
// transient failures (network, timeout, 5xx, non-JSON challenge pages) so the
// caller can keep the last good value.
async function fetchRoomContext(
  username: string
): Promise<{ check: Check; hlsSource: string | null; uid: string | null }> {
  const response = await fetch(`https://chaturbate.com/api/chatvideocontext/${username}/`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  const checkedAt = new Date().toISOString();

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
  }
  if (response.status === 404) {
    return { check: { username, isLive: false, roomStatus: "not_found", checkedAt }, hlsSource: null, uid: null };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const isLive = data.room_status === "public";
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    check: {
      username,
      isLive,
      roomStatus: data.room_status || "unknown",
      checkedAt,
      numViewers: isLive && typeof data.num_viewers === "number" ? data.num_viewers : null,
      roomTitle: str(data.room_title),
      startedAt:
        isLive && typeof data.start_timestamp === "number" && data.start_timestamp > 0
          ? new Date(data.start_timestamp * 1000).toISOString()
          : null,
      avatarUrl: str(data.summary_card_image),
      // Offline responses keep the last show's message; only trust it mid-show.
      statusMessage: inShow(data.room_status) ? str(data.hidden_message) : null,
    },
    hlsSource: typeof data.hls_source === "string" && data.hls_source ? data.hls_source : null,
    uid: str(data.broadcaster_uid) ?? str(data.room_uid),
  };
}

// --- Background checker ------------------------------------------------------
// One server-side loop checks rooms (least recently checked first) and caches
// the results. API reads come from the cache, so clients never wait on (or
// multiply) upstream requests.

const statusCache = loadStatusCache();
// Last poll time each room was seen live (in memory; feeds last_live_at).
const lastSeenLive = new Map<string, string>();
let gapMs = START_GAP_MS; // learned spacing between upstream requests
let pausedUntil = 0;
let okStreak = 0;
let lastCheckAt: string | null = null;
let checkTimer: NodeJS.Timeout | undefined;
let statusDirty = false;
let stopping = false;

function loadStatusCache(): Map<string, Check> {
  try {
    const saved: Check[] = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    return new Map(saved.map((c) => [c.username, c]));
  } catch {
    return new Map(); // missing or corrupt: it's only a cache
  }
}

// Batched (see STATUS_SAVE_INTERVAL_MS) to spare the SD card a write per check.
function saveStatusCache(): void {
  if (!statusDirty) return;
  statusDirty = false;
  const saved = rooms.flatMap((r) => statusCache.get(r.username) ?? []);
  try {
    writeJsonAtomic(STATUS_FILE, saved);
  } catch (err) {
    console.warn("couldn't save status cache:", (err as Error).message);
  }
}

function cacheCheck(check: Check): void {
  const avatarUrl = check.avatarUrl ?? statusCache.get(check.username)?.avatarUrl ?? null;
  check = { ...check, avatarUrl };
  statusCache.set(check.username, check);
  statusDirty = true;
  recordLiveTransition(check);
  const room = rooms.find((r) => r.username === check.username);
  if (room) broadcast("status", roomStatus(room));
}

// A polled result, unless push reported this room's status more recently:
// then keep the pushed status and take only the details from the poll.
function cachePolled(check: Check): void {
  const pushed = pushedAt.get(check.username);
  const prev = statusCache.get(check.username);
  const recentPush = pushed !== undefined && Date.now() - pushed < PUSH_TRUST_MS;
  if (prev && prev.roomStatus !== check.roomStatus) {
    if (recentPush) {
      check = {
        ...check,
        isLive: prev.isLive,
        roomStatus: prev.roomStatus,
        statusMessage: prev.statusMessage ?? null,
        numViewers: prev.isLive ? (check.numViewers ?? prev.numViewers) : null,
        startedAt: prev.isLive ? (check.startedAt ?? null) : null,
      };
    } else if (statusBucket(prev.roomStatus) !== statusBucket(check.roomStatus)) {
      // Push should have told us. Compared coarsely so a naming difference
      // between the two APIs can't look like a miss.
      push.reportMiss(check.username);
    }
  }
  cacheCheck(check);
}

function inShow(status: unknown): boolean {
  return typeof status === "string" && statusBucket(status) === "show";
}

function statusBucket(status: string): string {
  if (status === "public" || status === "offline") return status;
  if (status === "unknown" || status === "error" || status === "not_found") return "n/a";
  return "show";
}

function learnUid(username: string, uid: string | null): void {
  const room = rooms.find((r) => r.username === username);
  if (!room || !uid || room.uid === uid) return;
  room.uid = uid;
  saveRooms();
  syncPushRooms();
}

function recordLiveTransition(check: Check): void {
  const room = rooms.find((r) => r.username === check.username);
  if (!room) return; // removed while the check was in flight, or not saved

  const wasLive = Boolean(room.live_since);
  if (check.isLive) {
    lastSeenLive.set(room.username, check.checkedAt!);
    // Upstream's stream start beats our first sighting (which is late, and
    // wrong after a restart); fall back to the sighting if it's missing.
    const since = check.startedAt ?? (wasLive ? room.live_since : check.checkedAt);
    if (room.live_since !== since) {
      room.live_since = since;
      saveRooms();
    }
  } else if (wasLive) {
    // If we restarted mid-stream we never saw it live this process; the start
    // of the stream is the best lower bound we have.
    room.last_live_at = lastSeenLive.get(room.username) ?? room.live_since;
    room.live_since = null;
    saveRooms();
  }
}

// Spacing actually used: the learned gap, but no faster than needed to visit
// every room once per TARGET_ROOM_INTERVAL_MS.
function currentGap(): number {
  const target = push.connected ? PUSH_ROOM_INTERVAL_MS : TARGET_ROOM_INTERVAL_MS;
  return Math.max(gapMs, target / Math.max(rooms.length, 1));
}

function nextRoom(): string | undefined {
  let best: Room | undefined;
  let bestAt = "";
  for (const r of rooms) {
    const at = statusCache.get(r.username)?.checkedAt ?? ""; // never checked sorts first
    if (!best || at < bestAt) {
      best = r;
      bestAt = at;
    }
  }
  return best?.username;
}

function onRateLimited(err: RateLimitedError): void {
  okStreak = 0;
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS);
  pausedUntil = Date.now() + Math.max(err.retryAfterMs ?? 0, RATE_LIMIT_PAUSE_MS);
  console.warn(`rate limited upstream; pausing ${RATE_LIMIT_PAUSE_MS / 1000}s, gap now ${gapMs / 1000}s`);
}

async function checkNext(): Promise<void> {
  const username = nextRoom();
  if (!username) return;
  try {
    const ctx = await fetchRoomContext(username);
    learnUid(username, ctx.uid);
    cachePolled(ctx.check);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      onRateLimited(err);
      return;
    }
    console.warn(`status check failed for ${username}:`, (err as Error).message);
    // Keep the last good status; only record an error if we have nothing.
    if (!statusCache.has(username)) {
      cacheCheck({ username, isLive: false, roomStatus: "error", checkedAt: null });
    }
  }
  lastCheckAt = new Date().toISOString();
  if (++okStreak >= SUCCESSES_BEFORE_SPEEDUP && gapMs > MIN_GAP_MS) {
    okStreak = 0;
    gapMs = Math.max(Math.round(gapMs * 0.85), MIN_GAP_MS);
  }
}

async function checkLoop(): Promise<void> {
  if (stopping) return;
  if (Date.now() >= pausedUntil) {
    try {
      await checkNext();
    } catch (err) {
      console.error("check failed:", err);
    }
  }
  if (stopping) return;
  const delay = Math.max(pausedUntil - Date.now(), currentGap());
  checkTimer = setTimeout(checkLoop, delay);
}

const statusSaveTimer = setInterval(saveStatusCache, STATUS_SAVE_INTERVAL_MS);

// --- Push ----------------------------------------------------------------------

// When push last set each room's status (see cachePolled).
const pushedAt = new Map<string, number>();

// Recent tips per room, so a card can hint at a busy room. The browser decays
// it against its own clock, so there's no need to re-send as tips age out.
const TIP_WINDOW_MS = 5 * 60_000;
const tipLog = new Map<string, { at: number; amount: number }[]>();

function recentTips(username: string): { at: number; amount: number }[] {
  const cutoff = Date.now() - TIP_WINDOW_MS;
  const list = (tipLog.get(username) ?? []).filter((t) => t.at > cutoff);
  if (list.length) tipLog.set(username, list);
  else tipLog.delete(username);
  return list;
}
const roomByUid = (uid: string) => rooms.find((r) => r.uid === uid);

const push = new PushClient({
  status(uid, status, message) {
    const room = roomByUid(uid);
    if (!room) return;
    const prev = statusCache.get(room.username);
    const isLive = status === "public";
    if (prev?.roomStatus !== status) console.log(`push: ${room.username} ${prev?.roomStatus ?? "?"} -> ${status}`);
    pushedAt.set(room.username, Date.now());
    cacheCheck({
      username: room.username,
      isLive,
      roomStatus: status,
      checkedAt: new Date().toISOString(),
      // Viewers arrive with the next poll; the start time is "now" (see
      // recordLiveTransition), which is accurate for a push.
      numViewers: isLive && prev?.isLive ? prev.numViewers : null,
      roomTitle: prev?.roomTitle ?? null,
      startedAt: null,
      avatarUrl: prev?.avatarUrl ?? null,
      statusMessage: inShow(status) ? message || null : null,
    });
  },
  title(uid, title) {
    const room = roomByUid(uid);
    const prev = room && statusCache.get(room.username);
    if (prev) cacheCheck({ ...prev, roomTitle: title });
  },
  tip(uid, tip: Tip) {
    const room = roomByUid(uid);
    if (!room) return;
    broadcast("tip", { username: room.username, ...tip });
    tipLog.set(room.username, [...recentTips(room.username), { at: Date.now(), amount: tip.amount }]);
    broadcast("status", roomStatus(room));
  },
});

function syncPushRooms(): void {
  push.setRooms(rooms.flatMap((r) => r.uid ?? []));
}

// --- Server-sent events --------------------------------------------------------
// Browsers hold one /api/events stream: "status" (a RoomStatus, on every
// change or check) and "tip" ({ username, amount, from, message }).

const eventClients = new Set<express.Response>();

function broadcast(event: string, data: unknown): void {
  if (!eventClients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of eventClients) res.write(frame);
}

// Comment frames keep idle proxies from cutting the stream.
const eventKeepalive = setInterval(() => {
  for (const res of eventClients) res.write(": keepalive\n\n");
}, 25_000);

function roomStatus(room: Room): RoomStatus {
  const check = statusCache.get(room.username) ?? {
    username: room.username,
    isLive: false,
    roomStatus: "unknown",
    checkedAt: null,
  };
  return {
    ...check,
    liveSince: room.live_since ?? null,
    lastLiveAt: room.last_live_at ?? null,
    recentTips: recentTips(room.username),
  };
}

// --- API routes --------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  const gap = currentGap();
  res.json({
    ok: true,
    rooms: rooms.length,
    lastCheckAt,
    requestGapSeconds: gap / 1000,
    // Roughly how stale a room's status can get at the current pace.
    roomRefreshSeconds: Math.round((gap * rooms.length) / 1000),
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    push: {
      state: push.state,
      rooms: rooms.filter((r) => r.uid).length,
      lastEventAt: push.lastEventAt,
      rebuilds: push.rebuilds,
    },
    eventClients: eventClients.size,
  });
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Don't let a proxy buffer the stream.
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  eventClients.add(res);
  req.on("close", () => eventClients.delete(res));
});

// Get all saved rooms
app.get("/api/rooms", (_req, res) => {
  res.json(rooms);
});

// Add a room
app.post("/api/rooms", (req, res) => {
  const { username } = req.body ?? {};
  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "username is required" });
    return;
  }

  const normalized = normalizeUsername(username);
  if (!normalized) {
    res.status(400).json({ error: "Invalid username (letters, numbers and _ only)" });
    return;
  }

  if (rooms.some((r) => r.username === normalized)) {
    res.status(409).json({ error: "Room already saved" });
    return;
  }

  const newRoom: Room = {
    id: Math.max(Date.now(), ...rooms.map((r) => r.id + 1)),
    username: normalized,
    added_at: new Date().toISOString(),
  };

  rooms.push(newRoom);
  saveRooms();

  // Never checked, so it's next in line for the checker.

  res.status(201).json(newRoom);
});

// Delete a room
app.delete("/api/rooms/:id", (req, res) => {
  const id = Number(req.params.id);
  const index = rooms.findIndex((r) => r.id === id);

  if (index === -1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const [removed] = rooms.splice(index, 1);
  saveRooms();
  syncPushRooms();
  pushedAt.delete(removed.username);
  tipLog.delete(removed.username);
  statusCache.delete(removed.username);
  statusDirty = true;
  lastSeenLive.delete(removed.username);

  res.json({ success: true });
});

// Status of all saved rooms (from the poller's cache)
app.get("/api/rooms/status", (_req, res) => {
  res.json(rooms.map(roomStatus));
});

// Status of a single room: cached if saved, otherwise checked live
app.get("/api/rooms/:username/status", async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }
  const room = rooms.find((r) => r.username === username);
  if (room) {
    res.json(roomStatus(room));
    return;
  }
  try {
    const { check } = await fetchRoomContext(username);
    res.json({ ...check, liveSince: check.startedAt ?? null, lastLiveAt: null });
  } catch (err) {
    const status = err instanceof RateLimitedError ? 429 : 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

// Fresh, tokenised HLS URL for in-app playback. Never cached: each URL is good
// for one playback session (a second load of its playlist gets 403
// "session_duplicated"), so every preview/player/reconnect needs its own.
// The browser then plays straight from the CDN (it's CORS-open), so video
// never flows through this server.
app.get("/api/rooms/:username/stream", async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  // Shares the checker's IP budget: while it's backing off, so do we, rather
  // than prolonging the rate limit.
  if (Date.now() < pausedUntil) {
    res.status(429).json({ error: "Rate limited, try again shortly" });
    return;
  }

  let ctx;
  try {
    ctx = await fetchRoomContext(username);
  } catch (err) {
    if (err instanceof RateLimitedError) onRateLimited(err);
    const status = err instanceof RateLimitedError ? 429 : 502;
    res.status(status).json({ error: status === 429 ? "Rate limited, try again shortly" : "Couldn't reach Chaturbate" });
    return;
  }

  // Free status update for saved rooms while we're at it.
  if (rooms.some((r) => r.username === username)) {
    learnUid(username, ctx.uid);
    cachePolled(ctx.check);
  }

  if (!ctx.check.isLive || !ctx.hlsSource) {
    res.status(409).json({ error: "Not in a public show right now", roomStatus: ctx.check.roomStatus });
    return;
  }
  res.json({ src: ctx.hlsSource });
});

// Unknown API paths are a 404, not the SPA shell
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Serve static files in production
const distPath = path.join(__dirname, "..", "dist");
app.use(
  express.static(distPath, {
    // Vite's hashed bundles never change; everything else (index.html, sw.js,
    // manifest) revalidates so a redeploy is picked up straight away.
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);
app.use((_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`CB Checker server running on http://localhost:${PORT} (data: ${DATA_DIR}, ${rooms.length} rooms)`);
  checkLoop();
  syncPushRooms();
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopping = true;
  clearTimeout(checkTimer);
  clearInterval(statusSaveTimer);
  clearInterval(eventKeepalive);
  push.stop();
  // Open event streams would otherwise hold server.close() up.
  for (const res of eventClients) res.end();
  saveStatusCache();
  server.close(() => process.exit(0));
  // Don't let in-flight upstream requests hold the exit hostage.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
