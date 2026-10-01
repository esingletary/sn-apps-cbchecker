export interface Room {
  id: number;
  username: string;
  added_at: string;
}

export interface RoomStatus {
  username: string;
  isLive: boolean;
  roomStatus: string;
  url: string | null;
}

export async function fetchRooms(): Promise<Room[]> {
  const res = await fetch("/api/rooms");
  if (!res.ok) throw new Error("Failed to fetch rooms");
  return res.json();
}

export async function addRoom(username: string): Promise<Room> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to add room");
  }
  return res.json();
}

export async function deleteRoom(id: number): Promise<void> {
  const res = await fetch(`/api/rooms/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete room");
}

export async function fetchRoomStatuses(): Promise<RoomStatus[]> {
  const res = await fetch("/api/rooms/status");
  if (!res.ok) throw new Error("Failed to fetch statuses");
  return res.json();
}
