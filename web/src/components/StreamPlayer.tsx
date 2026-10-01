import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { fetchStreamUrl, roomUrl, StreamUnavailableError } from "../api";

type State = { kind: "loading" } | { kind: "playing" } | { kind: "error"; message: string };

// How many times to fetch a fresh token and reconnect after a fatal error
// before giving up (tokens expire; edges hiccup).
const MAX_RECONNECTS = 2;

// Full-screen overlay that plays a room's HLS stream straight from the CDN.
// Safari/iOS play HLS natively; elsewhere hls.js is loaded on demand so it
// never weighs down the main bundle.
export default function StreamPlayer({ username, onClose }: { username: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const video = videoRef.current!;
    let hls: Hls | null = null;
    let cancelled = false;
    let reconnects = 0;
    let mediaRecovered = false;

    const fail = (message: string) => {
      if (!cancelled) setState({ kind: "error", message });
    };

    const reconnect = () => {
      if (cancelled) return;
      if (reconnects >= MAX_RECONNECTS) {
        fail("The stream stopped. The room may have ended or gone private.");
        return;
      }
      reconnects++;
      setState({ kind: "loading" });
      connect();
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

      hls?.destroy();
      hls = null;

      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        const { default: HlsCtor } = await import("hls.js");
        if (cancelled) return;
        if (!HlsCtor.isSupported()) {
          fail("This browser can't play live streams.");
          return;
        }
        hls = new HlsCtor({ lowLatencyMode: true, backBufferLength: 30 });
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          // One in-place recovery for decode errors, then a full reconnect.
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
            mediaRecovered = true;
            hls?.recoverMediaError();
          } else {
            reconnect();
          }
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      }
      // Muted autoplay is allowed everywhere; sound needs a user gesture.
      video.play().catch(() => {});
    };

    const onPlaying = () => {
      reconnects = 0;
      mediaRecovered = false;
      if (!cancelled) setState({ kind: "playing" });
    };
    // Native HLS (Safari) reports failures here instead of through hls.js.
    const onError = () => {
      if (!hls) reconnect();
    };
    const onVolume = () => setMuted(video.muted);

    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onError);
    video.addEventListener("volumechange", onVolume);
    connect();

    return () => {
      cancelled = true;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", onVolume);
      hls?.destroy();
      // Stop downloading as soon as the overlay closes.
      video.removeAttribute("src");
      video.load();
    };
  }, [username]);

  // Escape closes; lock page scroll behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const unmute = () => {
    const video = videoRef.current!;
    video.muted = false;
    video.play().catch(() => {});
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center gap-3 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <span className="inline-flex items-center gap-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          Live
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-stone-100">{username}</span>
        <a
          href={roomUrl(username)}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 text-xs text-stone-400 hover:text-stone-200"
        >
          Open on Chaturbate ↗
        </a>
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          controls={state.kind === "playing"}
          className={`max-h-full w-full ${state.kind === "playing" ? "" : "invisible"}`}
        />

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
            className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/20 backdrop-blur-sm hover:bg-black/80"
          >
            🔇 Tap to unmute
          </button>
        )}
      </div>
    </div>
  );
}
