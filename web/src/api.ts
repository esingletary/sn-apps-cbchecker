export interface Room {
  id: number;
  username: string;
  added_at: string;
}

export interface RoomStatus {
  username: string;
  isLive: boolean;
  // Upstream room_status ("public", "private", "group", "away", "hidden",
  // "offline", ...) or "not_found" / "error" / "unknown" from our server.
  roomStatus: string;
  checkedAt: string | null;
  liveSince: string | null;
  lastLiveAt: string | null;
}

async function errorFrom(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    return new Error(body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function fetchRooms(): Promise<Room[]> {
  const res = await fetch("/api/rooms");
  if (!res.ok) throw await errorFrom(res, "Failed to fetch rooms");
  return res.json();
}

export async function addRoom(username: string): Promise<Room> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw await errorFrom(res, "Failed to add room");
  return res.json();
}

// `keepalive` lets a pending (undo-able) removal still go through if the page
// is closed while the undo toast is showing.
export async function deleteRoom(id: number, keepalive = false): Promise<void> {
  const res = await fetch(`/api/rooms/${id}`, { method: "DELETE", keepalive });
  if (!res.ok && res.status !== 404) throw await errorFrom(res, "Failed to remove room");
}

export async function fetchRoomStatuses(): Promise<RoomStatus[]> {
  const res = await fetch("/api/rooms/status");
  if (!res.ok) throw await errorFrom(res, "Failed to fetch statuses");
  return res.json();
}

export class StreamUnavailableError extends Error {}

// Fresh tokenised HLS URL. Throws StreamUnavailableError when the room isn't
// in a public show (offline, private, ...), so the player can say so.
export async function fetchStreamUrl(username: string): Promise<string> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(username)}/stream`, { cache: "no-store" });
  if (res.status === 409) throw new StreamUnavailableError((await res.json()).error);
  if (!res.ok) throw await errorFrom(res, "Couldn't load stream");
  return (await res.json()).src;
}

export function roomUrl(username: string): string {
  return `https://chaturbate.com/${username}/`;
}

// Live snapshot, refreshed upstream every ~15s. Offline rooms get a generic
// placeholder, so it's only worth showing while live. `v` busts the cache.
export function thumbUrl(username: string, v: string | null): string {
  return `https://thumb.live.mmcdn.com/ri/${username}.jpg${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}
