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
