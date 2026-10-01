import { RoomStatus } from "../api";

interface RoomCardProps {
  status: RoomStatus;
  onRemove: () => void;
}

export default function RoomCard({ status, onRemove }: RoomCardProps) {
  const { username, isLive, roomStatus } = status;

  return (
    <div
      className={`relative rounded-xl border p-4 transition-all ${
        isLive
          ? "border-green-500/30 bg-green-500/5 shadow-lg shadow-green-500/5"
          : "border-zinc-800 bg-zinc-900/50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={`https://chaturbate.com/${username}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-base font-semibold hover:text-orange-400 transition-colors truncate block"
          >
            {username}
          </a>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                isLive ? "bg-green-500 animate-pulse" : "bg-zinc-600"
              }`}
            />
            <span
              className={`text-sm font-medium ${
                isLive ? "text-green-400" : "text-zinc-500"
              }`}
            >
              {isLive ? "LIVE" : roomStatus === "error" ? "Error" : "Offline"}
            </span>
          </div>
        </div>
        <button
          onClick={onRemove}
          className="text-zinc-600 hover:text-red-400 transition-colors text-lg leading-none p-1"
          title="Remove room"
        >
          ✕
        </button>
      </div>
      {isLive && (
        <a
          href={`https://chaturbate.com/${username}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors"
        >
          <span>▶</span> Watch now
        </a>
      )}
    </div>
  );
}
