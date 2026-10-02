import { useEffect, useRef, useState } from "react";
import { fetchStreamUrl, roomUrl, StreamUnavailableError, type RoomStatus, type TipEvent } from "../api";
import { formatViewers, statusLabel } from "../status";
import { onServerEvent } from "../events";
import { LiveStream } from "../liveStream";

type State = { kind: "loading" } | { kind: "playing" } | { kind: "error"; message: string };

// How many times to fetch a fresh token and reconnect after a fatal error
// before giving up (tokens expire; edges hiccup).
const MAX_RECONNECTS = 2;

// Tip alerts: newest at the bottom, each fading out after TIP_MS (the fade is
// CSS, see .tip-alert). A burst of tips stacks up, which is the point: it
// shows the room's momentum.
const TIP_MS = 6_000;
const MAX_TIPS = 5;
let tipSeq = 0;

function TipAlert({ tip }: { tip: TipEvent }) {
  const tier =
    tip.amount >= 500
      ? "bg-orange-600/90 ring-orange-300/50 text-base"
      : tip.amount >= 100
        ? "bg-amber-500/85 ring-amber-200/40 text-sm"
        : "bg-black/60 ring-white/20 text-sm";
  return (
    <div className={`tip-alert w-fit max-w-full rounded-lg px-2.5 py-1.5 text-white shadow-lg ring-1 backdrop-blur-sm ${tier}`}>
      <p className="truncate">
        <span className="font-semibold tabular-nums">🪙 {tip.amount.toLocaleString()}</span>{" "}
        <span className="opacity-90">{tip.from ?? "Anonymous"}</span>
      </p>
      {tip.message && <p className="mt-0.5 truncate text-xs opacity-80">{tip.message}</p>}
    </div>
  );
}

// Full-screen overlay that plays a room's HLS stream straight from the CDN.
// Opened from a hover preview, it takes over that stream (`handoff`) and just
// shows it bigger; otherwise it starts its own.
export default function StreamPlayer({
  username,
  status,
  handoff,
  onClose,
  onPrev,
  onNext,
}: {
  username: string;
  // Live from the dashboard (pushed), for the header's viewers/title/badge.
  status?: RoomStatus;
  handoff?: LiveStream;
  onClose: () => void;
  // Previous/next live room; absent when there's nowhere to go.
  onPrev?: () => void;
  onNext?: () => void;
}) {
  // The <video> belongs to the LiveStream, not React, so it's placed in here.
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<LiveStream | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [muted, setMuted] = useState(true);
  const [tips, setTips] = useState<(TipEvent & { id: number })[]>([]);

  useEffect(
    () =>
      onServerEvent<TipEvent>("tip", (tip) => {
        if (tip.username !== username) return;
        const id = ++tipSeq;
        setTips((prev) => [...prev.slice(-(MAX_TIPS - 1)), { ...tip, id }]);
        setTimeout(() => setTips((prev) => prev.filter((t) => t.id !== id)), TIP_MS);
      }),
    [username]
  );

  useEffect(() => {
    // StrictMode's dev remount finds the handoff already destroyed.
    const adopted = handoff && !handoff.destroyed ? handoff : null;
    const stream = adopted ?? new LiveStream();
    streamRef.current = stream;
    const video = stream.video;
    video.removeAttribute("style");
    video.className = "max-h-full w-full";
    boxRef.current!.append(video);
    let cancelled = false;
    let reconnects = 0;

    const fail = (message: string) => {
      if (!cancelled) setState({ kind: "error", message });
    };

    const connect = async () => {
      let src: string;
      try {
        src = await fetchStreamUrl(username);
      } catch (err) {
        fail(err instanceof StreamUnavailableError ? err.message : "Couldn't load the stream.");
        return;
      }
      if (cancelled) return;
      if (!(await stream.load(src))) fail("This browser can't play live streams.");
    };

    // Each reconnect needs a new URL: they're good for one session.
    stream.onFatal = () => {
      if (cancelled) return;
      if (reconnects >= MAX_RECONNECTS) {
        fail("The stream stopped. The room may have ended or gone private.");
        return;
      }
      reconnects++;
      setState({ kind: "loading" });
      connect();
    };

    const onPlaying = () => {
      reconnects = 0;
      if (!cancelled) setState({ kind: "playing" });
    };
    const onVolume = () => setMuted(video.muted);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("volumechange", onVolume);
    setMuted(video.muted);

    if (adopted) {
      if (stream.isPlaying) setState({ kind: "playing" });
      video.play().catch(() => {});
    } else {
      connect();
    }

    return () => {
      cancelled = true;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("volumechange", onVolume);
      stream.destroy();
    };
  }, [username, handoff]);

  useEffect(() => {
    const video = streamRef.current?.video;
    if (!video) return;
    video.controls = state.kind === "playing";
    video.classList.toggle("invisible", state.kind !== "playing");
  }, [state]);

  // Fresh closures every render; read through a ref so the key handler
  // doesn't need re-binding.
  const nav = useRef({ onPrev, onNext });
  nav.current = { onPrev, onNext };

  // Escape closes, arrows switch rooms; lock page scroll behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const go = e.key === "ArrowLeft" ? nav.current.onPrev : e.key === "ArrowRight" ? nav.current.onNext : undefined;
      if (go) {
        e.preventDefault(); // not a seek on the focused video
        go();
      }
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // Horizontal swipe on the video switches rooms, like a story viewer.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    (dx < 0 ? onNext : onPrev)?.();
  };

  const unmute = () => {
    const video = streamRef.current?.video;
    if (!video) return;
    video.muted = false;
    video.play().catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center gap-3 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {status && !status.isLive ? (
              // The room left public (show, offline) while we were watching.
              <span className="shrink-0 rounded bg-stone-700 px-1.5 py-0.5 text-[11px] font-semibold text-stone-100">
                {statusLabel(status)}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                Live
              </span>
            )}
            <span className="min-w-0 truncate text-sm font-medium text-stone-100">{username}</span>
            {status?.isLive && status.numViewers != null && (
              <span
                className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-stone-300"
                title={`${status.numViewers.toLocaleString()} viewers`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                {formatViewers(status.numViewers)}
              </span>
            )}
          </div>
          {status?.roomTitle && (
            <p className="mt-0.5 truncate text-xs text-stone-400" title={status.roomTitle}>
              {status.roomTitle}
            </p>
          )}
        </div>
        <a
          href={roomUrl(username)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on Chaturbate"
          className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200"
        >
          <span className="hidden sm:inline">Open on Chaturbate </span>↗
        </a>
        {(onPrev || onNext) && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={onPrev}
              title="Previous live room (←)"
              aria-label="Previous live room"
              className="rounded p-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onNext}
              title="Next live room (→)"
              aria-label="Next live room"
              className="rounded p-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="shrink-0 rounded p-1.5 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div ref={boxRef} className="contents" />

        {tips.length > 0 && (
          <div className="pointer-events-none absolute left-3 top-3 flex max-w-[60vw] flex-col items-start gap-1.5 sm:max-w-sm">
            {tips.map((t) => (
              <TipAlert key={t.id} tip={t} />
            ))}
          </div>
        )}

        {state.kind === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-700 border-t-orange-500" />
          </div>
        )}

        {state.kind === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-sm text-stone-400">
            <p>{state.message}</p>
            <a
              href={roomUrl(username)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-stone-200 px-3 py-1.5 text-sm text-stone-900 hover:bg-stone-300"
            >
              Open on Chaturbate
            </a>
          </div>
        )}

        {state.kind === "playing" && muted && (
          <button
            type="button"
            onClick={unmute}
            className="absolute right-3 top-3 rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/20 backdrop-blur-sm hover:bg-black/80"
          >
            🔇 Tap to unmute
          </button>
        )}
      </div>
    </div>
  );
}
