import type { RoomStatus } from "./api";

export type Category = "live" | "show" | "offline" | "unknown" | "error" | "not_found";

// Display order: who you can watch now first, dead entries last.
const RANK: Record<Category, number> = { live: 0, show: 1, offline: 2, unknown: 3, error: 4, not_found: 5 };

export function categorize(s: RoomStatus): Category {
  if (s.isLive) return "live";
  switch (s.roomStatus) {
    case "offline":
      return "offline";
    case "unknown":
      return "unknown";
    case "error":
      return "error";
    case "not_found":
      return "not_found";
    default:
      // private, group, hidden, away, password protected, ...: online but not
      // freely watchable.
      return "show";
  }
}

const SHOW_LABELS: Record<string, string> = {
  private: "Private show",
  group: "Group show",
  hidden: "Hidden show",
  away: "Away",
  "password protected": "Password protected",
};

export function statusLabel(s: RoomStatus): string {
  switch (categorize(s)) {
    case "live":
      return "Live";
    case "show":
      // Ticket shows are hidden shows run by a ticket app, which says so.
      if (s.roomStatus === "hidden" && /ticket/i.test(s.statusMessage ?? "")) return "Ticket show";
      return SHOW_LABELS[s.roomStatus] ?? s.roomStatus.replace(/^\w/, (c) => c.toUpperCase());
    case "offline":
      return "Offline";
    case "unknown":
      return "Checking…";
    case "error":
      return "Couldn't check";
    case "not_found":
      return "Room not found";
  }
}

export function compareStatuses(a: RoomStatus, b: RoomStatus): number {
  const ca = categorize(a);
  const cb = categorize(b);
  if (ca !== cb) return RANK[ca] - RANK[cb];
  // Live: busiest first; rooms without a count yet (just went live) last.
  if (ca === "live") {
    const va = a.numViewers ?? -1;
    const vb = b.numViewers ?? -1;
    if (va !== vb) return vb - va;
  }
  // Offline: most recently live first; never-seen-live last.
  if (ca === "offline") {
    const la = a.lastLiveAt ? Date.parse(a.lastLiveAt) : 0;
    const lb = b.lastLiveAt ? Date.parse(b.lastLiveAt) : 0;
    if (la !== lb) return lb - la;
  }
  return a.username.localeCompare(b.username);
}

export function timeAgo(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// 161, 1.2k, 12k
export function formatViewers(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}

// Tokens tipped in the last `windowMs`, judged against the browser's clock so
// the hint fades without waiting for the server.
export const TIP_WINDOW_MS = 5 * 60_000;
export function recentTipTokens(s: RoomStatus, now: number, windowMs = TIP_WINDOW_MS): number {
  return (s.recentTips ?? []).reduce((sum, t) => (now - t.at < windowMs ? sum + t.amount : sum), 0);
}
