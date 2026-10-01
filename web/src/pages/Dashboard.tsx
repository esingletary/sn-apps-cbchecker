import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { addRoom, deleteRoom, fetchRooms, fetchRoomStatuses, type Room, type RoomStatus } from "../api";
import { categorize, compareStatuses, timeAgo } from "../status";
import { useNow } from "../hooks/useNow";
import { useVisiblePolling } from "../hooks/useVisiblePolling";
import Layout from "../components/Layout";
import Spinner from "../components/Spinner";
import IconButton from "../components/IconButton";
import RoomCard from "../components/RoomCard";
import AddRoomForm, { AddRoomDialog } from "../components/AddRoomForm";
import Toast, { type ToastData } from "../components/Toast";

// Split out (with hls.js behind it) so the dashboard stays light.
const StreamPlayer = lazy(() => import("../components/StreamPlayer"));

// The server checks upstream continuously; reading its cache is cheap, so
// check it often to pick up changes soon after they land.
const POLL_MS = 15_000;
// Past this, the server is probably being rate-limited; say so.
const STALE_MS = 3 * 60_000;
const UNDO_MS = 5_000;

function placeholderStatus(username: string): RoomStatus {
  return { username, isLive: false, roomStatus: "unknown", checkedAt: null, liveSince: null, lastLiveAt: null };
}

export default function Dashboard() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [statuses, setStatuses] = useState<Map<string, RoomStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  // Rooms removed but still inside their undo window: hidden, not yet deleted.
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const pendingTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const now = useNow(15_000);

  const showToast = useCallback((t: Omit<ToastData, "id">) => setToast({ ...t, id: Date.now() }), []);
  const showError = useCallback((message: string) => showToast({ message, tone: "error" }), [showToast]);
  const dismissToast = useCallback(() => setToast(null), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);

  // The player is a history entry, so the back button/gesture closes it
  // (important in the installed PWA, which has no browser chrome).
  const [playing, setPlaying] = useState<string | null>(null);
  const openPlayer = useCallback((username: string) => {
    history.pushState({ cbPlayer: username }, "");
    setPlaying(username);
  }, []);
  const closePlayer = useCallback(() => {
    if (history.state?.cbPlayer) history.back();
    else setPlaying(null);
  }, []);
  useEffect(() => {
    const onPop = () => setPlaying(history.state?.cbPlayer ?? null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const applyStatuses = (list: RoomStatus[]) => setStatuses(new Map(list.map((s) => [s.username, s])));

  const loadStatuses = useCallback(async () => {
    try {
      applyStatuses(await fetchRoomStatuses());
    } catch (err) {
      console.error("Failed to load statuses:", err);
    }
  }, []);

  useEffect(() => {
    fetchRooms()
      .then(setRooms)
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useVisiblePolling(loadStatuses, POLL_MS);

  // A removal still in its undo window goes through if the page is closed.
  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of pendingTimers.current) {
        clearTimeout(timer);
        deleteRoom(id, true).catch(() => {});
      }
      pendingTimers.current.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const setPending = (id: number, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleAdd = async (username: string) => {
    const room = await addRoom(username);
    setRooms((prev) => [...prev, room]);
    // A new room is next in line for the server's checker; pick it up shortly.
    setTimeout(loadStatuses, 6000);
  };

  const handleRemove = (room: Room) => {
    setPending(room.id, true);
    const timer = setTimeout(async () => {
      pendingTimers.current.delete(room.id);
      try {
        await deleteRoom(room.id);
        setRooms((prev) => prev.filter((r) => r.id !== room.id));
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to remove room");
      } finally {
        setPending(room.id, false);
      }
    }, UNDO_MS);
    pendingTimers.current.set(room.id, timer);

    showToast({
      message: `Removed ${room.username}`,
      actionLabel: "Undo",
      onAction: () => {
        clearTimeout(pendingTimers.current.get(room.id));
        pendingTimers.current.delete(room.id);
        setPending(room.id, false);
        setToast(null);
      },
    });
  };

  // Re-reads the server's cache. Deliberately doesn't force upstream checks:
  // bursts are what get us rate-limited.
  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadStatuses(), new Promise((r) => setTimeout(r, 400))]);
    setRefreshing(false);
  };

  const entries = rooms
    .filter((r) => !pendingIds.has(r.id))
    .map((room) => ({ room, status: statuses.get(room.username) ?? placeholderStatus(room.username) }))
    .sort((a, b) => compareStatuses(a.status, b.status));

  const liveCount = entries.filter((e) => categorize(e.status) === "live").length;
  const showCount = entries.filter((e) => categorize(e.status) === "show").length;
  const updatedAt = entries.reduce<string | null>(
    (latest, e) => (e.status.checkedAt && (!latest || e.status.checkedAt > latest) ? e.status.checkedAt : latest),
    null
  );

  const actions = (
    <>
      <AddRoomForm onAdd={handleAdd} onError={showError} />
      <div className="flex items-center gap-1">
        <IconButton onClick={() => setAddOpen(true)} title="Add room" className="md:hidden">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
        <IconButton onClick={handleRefresh} disabled={refreshing} title="Reload">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={refreshing ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </IconButton>
      </div>
    </>
  );

  let body;
  if (loading) {
    body = <Spinner />;
  } else if (loadError) {
    body = <div className="flex items-center justify-center py-20 text-sm text-red-500 dark:text-red-400">{loadError}</div>;
  } else if (entries.length === 0) {
    body = (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-sm text-stone-400 dark:text-stone-500">
        <p>No rooms saved yet.</p>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded bg-stone-800 px-3 py-1.5 text-sm text-white hover:bg-stone-700 dark:bg-stone-200 dark:text-stone-900 dark:hover:bg-stone-300"
        >
          Add a room
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <div className="mb-4 flex items-baseline justify-between gap-4 text-sm text-stone-500 dark:text-stone-400">
          <p>
            <span className={liveCount ? "font-medium text-red-600 dark:text-red-400" : ""}>{liveCount} live</span>
            {showCount > 0 && <> · {showCount} in shows</>} · {entries.length} saved
          </p>
          {updatedAt && (
            <p
              className={`shrink-0 text-xs ${
                now - Date.parse(updatedAt) > STALE_MS ? "text-amber-600 dark:text-amber-400" : "text-stone-400 dark:text-stone-500"
              }`}
              title={now - Date.parse(updatedAt) > STALE_MS ? "Checks are paused or slowed, likely rate-limited upstream" : undefined}
            >
              Updated {timeAgo(updatedAt, now)}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {entries.map(({ room, status }) => (
            <RoomCard
              key={room.id}
              status={status}
              now={now}
              onRemove={() => handleRemove(room)}
              onPlay={() => openPlayer(room.username)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <Layout actions={actions}>
      {body}
      {addOpen && <AddRoomDialog onAdd={handleAdd} onClose={closeAdd} />}
      {playing && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black" />}>
          <StreamPlayer key={playing} username={playing} onClose={closePlayer} />
        </Suspense>
      )}
      <Toast toast={toast} durationMs={UNDO_MS} onDismiss={dismissToast} />
    </Layout>
  );
}
