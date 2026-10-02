import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { roomUrl, thumbUrl, type RoomStatus } from "../api";
import type { LiveStream } from "../liveStream";
import {
  categorize,
  duration,
  formatViewers,
  recentTipTokens,
  statusLabel,
  timeAgo,
  type Category,
} from "../status";

// Pulls in hls.js on first hover, not with the dashboard.
const HoverPreview = lazy(() => import("./HoverPreview"));

// Tokens tipped in the last 5 minutes for a card to get the 🔥 busy hint.
const HOT_TOKENS = 100;

// How long the pointer has to rest on a card before its preview starts, so
// sweeping across the grid doesn't fire a stream request per card.
const PREVIEW_DELAY_MS = 400;

function detailLine(s: RoomStatus, cat: Category, now: number): string {
  switch (cat) {
    case "live":
      return s.liveSince ? `Live for ${duration(s.liveSince, now)}` : "Live now";
    case "offline":
      return s.lastLiveAt ? `Last live ${timeAgo(s.lastLiveAt, now)}` : "Offline";
    default:
      return statusLabel(s);
  }
}

function Badge({ cat, label, viewers }: { cat: Category; label: string; viewers?: number | null }) {
  if (cat === "live") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          Live
        </span>
        {viewers != null && (
          <span
            className="inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white ring-1 ring-white/20 backdrop-blur-sm"
            title={`${viewers.toLocaleString()} viewers`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {formatViewers(viewers)}
          </span>
        )}
      </span>
    );
  }
  if (cat === "show") {
    return <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-semibold text-stone-950 shadow">{label}</span>;
  }
  if (cat === "not_found" || cat === "error") {
    return (
      <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white ring-1 ring-white/20 backdrop-blur-sm">
        {label}
      </span>
    );
  }
  return null;
}

export default function RoomCard({
  status,
  now,
  onRemove,
  onPlay,
}: {
  status: RoomStatus;
  now: number;
  onRemove: () => void;
  // Given the hover preview's stream when there is one, so the player can
  // take it over instead of starting a new one.
  onPlay: (stream?: LiveStream) => void;
}) {
  const { username } = status;
  const cat = categorize(status);
  const src = thumbUrl(username, status.checkedAt);
  // Remember which thumbnail URL failed so a later refresh gets a fresh try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showThumb = cat === "live" && failedSrc !== src;
  // Live only: offline rooms get tipped too, but that isn't a busy room.
  const tipTokens = cat === "live" ? recentTipTokens(status, now) : 0;
  const avatar = status.avatarUrl ?? null;
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showAvatar = !showThumb && cat !== "unknown" && avatar !== null && failedAvatar !== avatar;

  // Hover preview: mouse/trackpad only (touch taps go straight to the player).
  const [previewing, setPreviewing] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewStream = useRef<LiveStream | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopPreview = () => {
    clearTimeout(previewTimer.current);
    previewStream.current = null;
    setPreviewing(false);
    setPreviewPlaying(false);
  };
  // A room that drops out of public mid-hover stops previewing.
  useEffect(() => {
    if (cat !== "live") stopPreview();
  }, [cat]);
  useEffect(() => () => clearTimeout(previewTimer.current), []);

  return (
    <div className="group relative overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-stone-200 transition hover:shadow-md dark:bg-stone-900 dark:ring-stone-700 dark:hover:shadow-lg dark:hover:ring-stone-500">
      <a
        href={roomUrl(username)}
        target="_blank"
        rel="noopener noreferrer"
        title={status.roomTitle ?? undefined}
        onPointerEnter={(e) => {
          if (cat !== "live" || e.pointerType !== "mouse") return;
          clearTimeout(previewTimer.current);
          previewTimer.current = setTimeout(() => setPreviewing(true), PREVIEW_DELAY_MS);
        }}
        onPointerLeave={stopPreview}
        onClick={(e) => {
          // Live rooms play in-app. Modified clicks (cmd/ctrl/shift/middle)
          // still open the site in a new tab as usual.
          if (cat !== "live" || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          const stream = previewStream.current;
          if (stream && !stream.destroyed) {
            stream.handedOff = true;
            stream.park();
            onPlay(stream);
          } else {
            onPlay();
          }
          stopPreview();
        }}
        className="block"
      >
        <div className="relative aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-stone-800">
          {showThumb ? (
            <img
              src={src}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setFailedSrc(src)}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : showAvatar ? (
            <img
              src={avatar!}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setFailedAvatar(avatar)}
              className={`h-full w-full object-cover ${cat === "show" ? "" : "opacity-60 grayscale"}`}
            />
          ) : cat === "unknown" ? (
            <div className="h-full w-full animate-pulse bg-stone-200 dark:bg-stone-800" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <span
                className={`text-5xl font-semibold uppercase ${
                  cat === "show" ? "text-amber-500/40" : "text-stone-300 dark:text-stone-700"
                }`}
              >
                {username[0]}
              </span>
            </div>
          )}
          {previewing && (
            <Suspense fallback={null}>
              <HoverPreview
                username={username}
                onStream={(stream) => {
                  previewStream.current = stream;
                  setPreviewPlaying(stream !== null);
                }}
              />
            </Suspense>
          )}
          <div className="absolute left-1.5 top-1.5 flex items-center gap-1.5">
            <Badge cat={cat} label={statusLabel(status)} viewers={status.numViewers} />
            {tipTokens >= HOT_TOKENS && (
              <span
                className="rounded bg-black/55 px-1 py-0.5 text-[11px] leading-none ring-1 ring-white/20 backdrop-blur-sm"
                title={`${tipTokens.toLocaleString()} tokens tipped in the last 5 minutes`}
              >
                🔥
              </span>
            )}
          </div>
          {cat === "live" && !previewPlaying && (
            <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
                </svg>
              </span>
            </div>
          )}
        </div>
        <div className="p-2.5">
          <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-200">{username}</p>
          <p
            className={`mt-0.5 truncate text-xs ${
              cat === "live" ? "text-red-600 dark:text-red-400" : "text-stone-400 dark:text-stone-500"
            }`}
          >
            {detailLine(status, cat, now)}
          </p>
        </div>
      </a>
      {/* Hidden until hover on pointer devices; always visible on touch. */}
      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${username}`}
        aria-label={`Remove ${username}`}
        className="absolute right-1.5 top-1.5 flex items-center justify-center rounded bg-black/55 p-1 text-white ring-1 ring-white/20 backdrop-blur-sm transition hover:bg-red-600 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
