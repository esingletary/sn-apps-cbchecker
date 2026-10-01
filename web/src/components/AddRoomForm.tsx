import { useState } from "react";

interface AddRoomFormProps {
  onAdd: (username: string) => Promise<void>;
}

export default function AddRoomForm({ onAdd }: AddRoomFormProps) {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      await onAdd(trimmed);
      setUsername("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add room");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <div className="flex-1 relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">
          chaturbate.com/
        </span>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className="w-full rounded-lg bg-zinc-900 border border-zinc-800 pl-36 pr-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 transition-colors"
          disabled={loading}
        />
      </div>
      <button
        type="submit"
        disabled={loading || !username.trim()}
        className="px-4 py-2.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
      >
        {loading ? "..." : "Add"}
      </button>
      {error && (
        <p className="absolute -bottom-6 left-0 text-xs text-red-400">{error}</p>
      )}
    </form>
  );
}
