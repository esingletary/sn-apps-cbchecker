import { useEffect, useRef, useState } from "react";
import { fetchStreamUrl, thumbUrl, type RoomStatus } from "../api";
import { LiveStream } from "../liveStream";
import { useNow } from "../hooks/useNow";
import { categorize, formatViewers, statusLabel } from "../status";
import { TipAlertStack, useTipAlerts } from "./TipAlerts";

// Up to 2×2 live rooms at once. Opens filled with the busiest live rooms; a
// tile whose room leaves public is swapped for the next busiest one not on
// screen (after a grace period, since rooms often blip offline for seconds).
// Each tile is its own stream session (tested: the CDN allows several per IP).
//
// Expanding a tile hands its stream to the full player while this stays
// mounted underneath, suspended: the other tiles stop downloading but keep
// their sessions. Back from the player returns the stream to its tile.
const MAX_TILES = 4;
const GONE_GRACE_MS = 20_000;
// Spaces the tiles' stream requests so opening the grid isn't an API burst.
const START_STAGGER_MS = 700;
const MAX_RECONNECTS = 2;
const TILE_VIDEO_CLASS = "h-full w-full object-contain";

type TileState = "loading" | "playing" | "error";

function Tile({
  username,
  status,
  startDelayMs,
  audible,
  suspended,
  returned,
  canSwap,
  onToggleAudio,
  onClaimAudio,
  onPickSwap,
  onExpand,
  onAdopted,
}: {
  username: string;
  status?: RoomStatus;
  startDelayMs: number;
  audible: boolean;
  suspended: boolean;
  // This tile's stream, back from the full player.
  returned: LiveStream | null;
  canSwap: boolean;
  onToggleAudio: () => void;
  onClaimAudio: () => void;
  onPickSwap: () => void;
  onExpand: (stream?: LiveStream) => void;
  onAdopted: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<LiveStream | null>(null);
  // The current stream's fatal handler, to reinstate when it comes back.
  const fatalRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<TileState>("loading");
  const [attempt, setAttempt] = useState(0);
  const tips = useTipAlerts(username, 3);

  useEffect(() => {
    const stream = new LiveStream();
    streamRef.current = stream;
    const video = stream.video;
    video.className = TILE_VIDEO_CLASS;
    video.muted = !audible;
    boxRef.current!.append(video);
    let cancelled = false;
    let reconnects = 0;
    setState("loading");

    const connect = async () => {
      try {
        const src = await fetchStreamUrl(username);
        if (cancelled) return;
        if (!(await stream.load(src, { lowStart: true }))) setState("error");
      } catch {
        if (!cancelled) setState("error");
      }
    };
    stream.onFatal = () => {
      if (cancelled) return;
      if (reconnects >= MAX_RECONNECTS) {
        setState("error");
        return;
      }
      reconnects++;
      setState("loading");
      connect();
    };
    fatalRef.current = stream.onFatal;
    const onPlaying = () => {
      reconnects = 0;
      if (!cancelled) setState("playing");
    };
    video.addEventListener("playing", onPlaying);
    const startTimer = setTimeout(connect, attempt ? 0 : startDelayMs);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      video.removeEventListener("playing", onPlaying);
      if (!stream.handedOff) stream.destroy();
    };
    // `audible`/`suspended` are applied by the effects below without
    // restarting the stream; the start delay only matters for the first connect.
  }, [username, attempt]);

  useEffect(() => {
    const video = streamRef.current?.video;
    if (!video || streamRef.current?.handedOff) return;
    video.muted = !audible;
    // Unmuting needs a gesture, which the tap that set `audible` was.
    if (audible) video.play().catch(() => {});
  }, [audible]);

  // Pause while the full player is up; pick up at the live edge after.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    if (suspended) {
      if (!stream.handedOff && !stream.destroyed) stream.suspend();
    } else if (stream.destroyed) {
      // The player ended it (e.g. it moved on to another room): start over.
      setAttempt((n) => n + 1);
    } else if (!stream.handedOff) {
      stream.resume();
    }
    // Still handed off: the player is returning it (see below).
  }, [suspended]);

  useEffect(() => {
    if (!returned) return;
    if (returned !== streamRef.current) {
      // Not ours any more (tile restarted meanwhile).
      returned.destroy();
      onAdopted();
      return;
    }
    returned.handedOff = false;
    returned.onFatal = fatalRef.current;
    const video = returned.video;
    video.removeAttribute("style");
    video.className = TILE_VIDEO_CLASS;
    boxRef.current!.append(video);
    // Unmuted in the player: keep the sound on this tile.
    if (!video.muted) onClaimAudio();
    // Returned early (the player moved on to another room) while still hidden:
    // hold it until the grid is back.
    if (suspended) returned.suspend();
    else video.play().catch(() => {});
    setState("playing");
    onAdopted();
  }, [returned]);

  const expand = () => {
    const stream = streamRef.current;
    if (stream && !stream.destroyed && stream.isPlaying) {
      stream.handedOff = true;
      stream.park();
      onExpand(stream);
    } else {
      onExpand();
    }
  };

  const live = status ? categorize(status) === "live" : true;
  // Controls hide until hover on pointer devices; always shown on touch.
  const hoverOnly = "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition";

  return (
    <div className="group relative min-h-0 min-w-0 overflow-hidden bg-stone-950" onClick={onToggleAudio}>
      <div ref={boxRef} className={`h-full w-full ${state === "playing" ? "" : "invisible"}`} />

      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-stone-700 border-t-orange-500" />
        </div>
      )}
      {(state === "error" || !live) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stone-950/80 text-center text-xs text-stone-400">
          <p>{!live && status ? statusLabel(status) : "Couldn't load the stream."}</p>
          {live && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAttempt((n) => n + 1);
              }}
              className="rounded bg-stone-200 px-2 py-1 text-stone-900 hover:bg-stone-300"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <TipAlertStack tips={tips} compact />

      {/* Top-right: swap and expand. */}
      <div className={`absolute right-1.5 top-1.5 flex items-center gap-1 ${hoverOnly}`} onClick={(e) => e.stopPropagation()}>
        {canSwap && (
          <button
            type="button"
            onClick={onPickSwap}
            title="Swap for another live room"
            aria-label="Swap for another live room"
            className="rounded bg-black/60 p-1.5 text-white ring-1 ring-white/20 backdrop-blur-sm hover:bg-black/80"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 16V4M7 4 3 8M7 4l4 4M17 8v12m0 0 4-4m-4 4-4-4" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={expand}
          title="Open in the full player"
          aria-label="Open in the full player"
          className="rounded bg-black/60 p-1.5 text-white ring-1 ring-white/20 backdrop-blur-sm hover:bg-black/80"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {/* Bottom: who this is, and whether it's the one with sound. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-xs text-white">
        <span className="min-w-0 truncate font-medium">{username}</span>
        {status?.isLive && status.numViewers != null && (
          <span className="shrink-0 tabular-nums text-stone-300">👁 {formatViewers(status.numViewers)}</span>
        )}
        <span className="ml-auto shrink-0" title={audible ? "Sound on (tap to mute)" : "Tap for sound"}>
          {audible ? "🔊" : "🔇"}
        </span>
      </div>
    </div>
  );
}

// Full-grid sheet of live rooms not on screen, as thumbnails.
function SwapSheet({
  replacing,
  candidates,
  statuses,
  onPick,
  onClose,
}: {
  replacing: string;
  candidates: string[];
  statuses: Map<string, RoomStatus>;
  onPick: (username: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="min-w-0 truncate text-sm text-stone-300">
          Swap <span className="font-medium text-stone-100">{replacing}</span> for…
        </p>
        <button
          type="button"
          onClick={onClose}
          title="Cancel"
          aria-label="Cancel"
          className="ml-auto shrink-0 rounded p-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {candidates.map((u) => {
            const s = statuses.get(u);
            return (
              <button
                key={u}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(u);
                }}
                className="group overflow-hidden rounded-lg bg-stone-900 text-left ring-1 ring-stone-700 transition hover:ring-orange-500"
              >
                <div className="relative aspect-[4/3] overflow-hidden bg-stone-800">
                  <img
                    src={thumbUrl(u, s?.checkedAt ?? null)}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                  {s?.numViewers != null && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] tabular-nums text-white ring-1 ring-white/20">
                      👁 {formatViewers(s.numViewers)}
                    </span>
                  )}
                </div>
                <p className="truncate px-2 py-1.5 text-sm font-medium text-stone-200">{u}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function MultiView({
  liveOrder,
  statuses,
  suspended,
  returned,
  onAdopted,
  onClose,
  onExpand,
}: {
  // Live rooms, busiest first.
  liveOrder: string[];
  statuses: Map<string, RoomStatus>;
  // Hidden under the full player.
  suspended: boolean;
  // A tile's stream coming back from the full player.
  returned: { username: string; stream: LiveStream } | null;
  onAdopted: () => void;
  onClose: () => void;
  onExpand: (username: string, stream?: LiveStream) => void;
}) {
  const [slots, setSlots] = useState<string[]>(() => liveOrder.slice(0, MAX_TILES));
  const [audio, setAudio] = useState<string | null>(null);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  // When each on-screen room was first seen not live, for the grace period.
  const goneSince = useRef(new Map<string, number>());
  const now = useNow(5_000);
  const openedAt = useRef(Date.now());

  // Replace rooms that have stayed out of public past the grace period, and
  // grow back to MAX_TILES as rooms come online. Held while suspended, so the
  // expanded room's tile is still there to take its stream back.
  const liveKey = liveOrder.join();
  useEffect(() => {
    if (suspended) return;
    const live = new Set(liveOrder);
    const spare = liveOrder.filter((u) => !slots.includes(u));
    let changed = false;
    const next = slots.map((u) => {
      if (live.has(u)) {
        goneSince.current.delete(u);
        return u;
      }
      const since = goneSince.current.get(u) ?? Date.now();
      goneSince.current.set(u, since);
      if (Date.now() - since < GONE_GRACE_MS || !spare.length) return u;
      goneSince.current.delete(u);
      changed = true;
      return spare.shift()!;
    });
    while (next.length < MAX_TILES && spare.length) {
      next.push(spare.shift()!);
      changed = true;
    }
    if (changed) setSlots(next);
    // `now` re-runs this so grace periods expire without a status change.
  }, [liveKey, slots, now, suspended]);

  // The room with sound left the grid.
  useEffect(() => {
    if (audio && !slots.includes(audio)) setAudio(null);
  }, [slots, audio]);

  // A returned stream whose tile is gone has nowhere to go.
  useEffect(() => {
    if (returned && !slots.includes(returned.username)) {
      returned.stream.destroy();
      onAdopted();
    }
  }, [returned, slots, onAdopted]);

  // Escape closes the swap sheet, then the grid (not while the player's up:
  // it has its own); lock page scroll behind the overlay.
  useEffect(() => {
    if (suspended) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (swapFor) setSwapFor(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, suspended, swapFor]);

  const candidates = liveOrder.filter((u) => !slots.includes(u));
  const n = slots.length;
  // 1: full; 2: side by side in landscape, stacked in portrait; 3–4: 2×2.
  const grid =
    n <= 1
      ? "grid-cols-1"
      : n === 2
        ? "grid-cols-1 grid-rows-2 landscape:grid-cols-2 landscape:grid-rows-1"
        : "grid-cols-2 grid-rows-2";

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
        suspended ? "hidden" : ""
      }`}
    >
      <div className="flex items-center gap-3 py-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <span className="text-sm font-medium text-stone-100">Multi-view</span>
        <span className="text-xs text-stone-500">Tap a room for sound</span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="ml-auto shrink-0 rounded p-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {n === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-stone-500">Nobody's live right now.</div>
      ) : (
        <div className={`relative grid min-h-0 flex-1 gap-0.5 ${grid}`}>
          {slots.map((u, i) => (
            <Tile
              key={u}
              username={u}
              status={statuses.get(u)}
              // Only the initial fill is staggered; a swapped-in tile starts now.
              startDelayMs={Date.now() - openedAt.current < 3_000 ? i * START_STAGGER_MS : 0}
              audible={audio === u}
              suspended={suspended}
              returned={returned?.username === u ? returned.stream : null}
              canSwap={candidates.length > 0}
              onToggleAudio={() => setAudio((cur) => (cur === u ? null : u))}
              onClaimAudio={() => setAudio(u)}
              onPickSwap={() => setSwapFor(u)}
              onExpand={(stream) => onExpand(u, stream)}
              onAdopted={onAdopted}
            />
          ))}
          {swapFor && (
            <SwapSheet
              replacing={swapFor}
              candidates={candidates}
              statuses={statuses}
              onPick={(to) => {
                setSlots((prev) => prev.map((s) => (s === swapFor ? to : s)));
                setSwapFor(null);
              }}
              onClose={() => setSwapFor(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
