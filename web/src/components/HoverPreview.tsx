import { useEffect, useRef } from "react";
import { fetchStreamUrl } from "../api";
import { LiveStream } from "../liveStream";

// Muted live preview laid over a card's thumbnail while it's hovered. Stays
// invisible until frames arrive, so the thumbnail shows through while loading
// and on any failure (no retries: it's a preview, the full player has those).
// `onStream` reports the stream once it's playing (null if it dies), so the
// card can hand it to the full player instead of starting another.
export default function HoverPreview({
  username,
  onStream,
}: {
  username: string;
  onStream: (stream: LiveStream | null) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stream = new LiveStream();
    const video = stream.video;
    video.className = "h-full w-full object-cover opacity-0 transition-opacity duration-300";
    boxRef.current!.append(video);

    stream.onFatal = () => {
      stream.destroy();
      onStream(null);
    };
    const onPlaying = () => {
      video.classList.replace("opacity-0", "opacity-100");
      onStream(stream);
    };
    video.addEventListener("playing", onPlaying);

    fetchStreamUrl(username).then(
      (src) => stream.load(src, { lowStart: true }),
      () => {}
    );

    return () => {
      video.removeEventListener("playing", onPlaying);
      if (!stream.handedOff) stream.destroy();
    };
    // onStream is a fresh closure each render; don't restart the stream for it.
  }, [username]);

  return <div ref={boxRef} className="pointer-events-none absolute inset-0" />;
}
