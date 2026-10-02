import type Hls from "hls.js";

// One live HLS playback: a <video> element plus (outside Safari) its hls.js
// instance. It lives outside React so it can move between owners, from a
// card's hover preview to the full player, without restarting. That matters
// because each stream URL is good for one session: a second load gets 403.
export class LiveStream {
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  private mediaRecovered = false;
  destroyed = false;
  // Set when the preview gives the stream to the player, so the preview's
  // cleanup leaves it running.
  handedOff = false;
  // Called when the stream can't continue; the owner decides what's next.
  onFatal: (() => void) | null = null;

  constructor() {
    const video = document.createElement("video");
    // Muted autoplay is allowed everywhere; sound needs a user gesture.
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    // Native HLS (Safari) reports failures here instead of through hls.js.
    video.addEventListener("error", () => {
      if (!this.hls) this.onFatal?.();
    });
    video.addEventListener("playing", () => {
      this.mediaRecovered = false;
    });
    this.video = video;
  }

  get isPlaying(): boolean {
    return !this.video.paused && this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  // Starts (or restarts, on the same element) playback of `src`. Resolves
  // false if this browser can't play HLS at all. `lowStart` begins at the
  // lowest rendition, for small tiles; it still climbs as the element grows.
  async load(src: string, { lowStart = false } = {}): Promise<boolean> {
    if (this.destroyed) return true;
    this.hls?.destroy();
    this.hls = null;
    const video = this.video;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else {
      // Loaded on demand so hls.js never weighs down the main bundle.
      const { default: HlsCtor } = await import("hls.js");
      if (this.destroyed) return true;
      if (!HlsCtor.isSupported()) return false;
      const hls = new HlsCtor({
        lowLatencyMode: true,
        backBufferLength: 30,
        capLevelToPlayerSize: true,
        startLevel: lowStart ? 0 : -1,
        // Jump back to the live edge if playback falls this many target
        // durations behind (after a stall, or a resume from suspend()).
        liveMaxLatencyDurationCount: 10,
      });
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (!data.fatal || this.hls !== hls) return;
        // One in-place recovery for decode errors; anything else is fatal.
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
          this.mediaRecovered = true;
          hls.recoverMediaError();
        } else {
          this.onFatal?.();
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      this.hls = hls;
    }
    video.play().catch(() => {});
    return true;
  }

  // Stops downloading and pauses, keeping the session (for a hidden tile).
  suspend(): void {
    this.hls?.stopLoad();
    this.video.pause();
  }

  // Undoes suspend(), back at the live edge. If the session lapsed meanwhile,
  // the load fails and the owner's onFatal reconnects as usual.
  resume(): void {
    const video = this.video;
    if (this.hls) {
      this.hls.startLoad(-1);
      const live = this.hls.liveSyncPosition;
      if (live != null) video.currentTime = live;
    } else if (video.seekable.length) {
      video.currentTime = Math.max(video.seekable.end(video.seekable.length - 1) - 3, 0);
    }
    video.play().catch(() => {});
  }

  // Holds the element, hidden, in the document while it changes owners: a
  // media element that leaves the document gets paused.
  park(): void {
    this.video.style.display = "none";
    document.body.appendChild(this.video);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onFatal = null;
    this.hls?.destroy();
    this.hls = null;
    // Stop downloading right away.
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
  }
}
