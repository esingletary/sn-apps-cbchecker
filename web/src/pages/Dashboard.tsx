import { useState, useEffect, useCallback } from "react";
import {
  fetchRooms,
  addRoom,
  deleteRoom,
  fetchRoomStatuses,
  Room,
  RoomStatus,
} from "../api";
import RoomCard from "../components/RoomCard";
import AddRoomForm from "../components/AddRoomForm";

export default function Dashboard() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [statuses, setStatuses] = useState<Map<string, RoomStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadRooms = useCallback(async () => {
    try {
      const data = await fetchRooms();
      setRooms(data);
    } catch (err) {
      console.error("Failed to load rooms:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchRoomStatuses();
      const map = new Map<string, RoomStatus>();
      data.forEach((s) => map.set(s.username, s));
      setStatuses(map);
    } catch (err) {
      console.error("Failed to load statuses:", err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    loadStatuses();
    const interval = setInterval(loadStatuses, 30000);
    return () => clearInterval(interval);
  }, [loadStatuses]);

  const handleAdd = async (username: string) => {
    await addRoom(username);
    await loadRooms();
    await loadStatuses();
  };

  const handleRemove = async (id: number) => {
    await deleteRoom(id);
    await loadRooms();
    await loadStatuses();
  };

  const liveCount = Array.from(statuses.values()).filter((s) => s.isLive).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">My Rooms</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {rooms.length} saved · {liveCount} live now
          </p>
        </div>
        <button
          onClick={loadStatuses}
          disabled={refreshing}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
        >
          {refreshing ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {/* Add Room Form */}
      <div className="relative">
        <AddRoomForm onAdd={handleAdd} />
      </div>

      {/* Room List */}
      {rooms.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-500 text-sm">No rooms saved yet.</p>
          <p className="text-zinc-600 text-xs mt-1">
            Add a Chaturbate username above to start tracking.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rooms.map((room) => {
            const status = statuses.get(room.username);
            return (
              <RoomCard
                key={room.id}
                status={
                  status || {
                    username: room.username,
                    isLive: false,
                    roomStatus: "unknown",
                    url: null,
                    checkedAt: null,
                  }
                }
                onRemove={() => handleRemove(room.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
