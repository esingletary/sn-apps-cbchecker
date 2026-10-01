import { useEffect, useRef, useState } from "react";

type OnAdd = (username: string) => Promise<void>;

const INPUT_CLASS =
  "w-full rounded border border-stone-200 bg-stone-50 px-3 text-base text-stone-700 placeholder-stone-400 outline-none focus:border-stone-400 focus:bg-white disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:placeholder-stone-500 dark:focus:border-stone-500 dark:focus:bg-stone-800";

const PLACEHOLDER = "Add username or room link…";

// Shared submit state for the inline (desktop) and dialog (mobile) forms.
function useAddRoom(onAdd: OnAdd, onError?: (message: string) => void) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<boolean> => {
    const v = value.trim();
    if (!v || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await onAdd(v);
      setValue("");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to add room";
      setError(message);
      onError?.(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { value, setValue, busy, error, submit };
}

const inputProps = {
  type: "text",
  placeholder: PLACEHOLDER,
  enterKeyHint: "go",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

// Header search-style input, shown from md up (like zscraper's search box).
export default function AddRoomForm({ onAdd, onError }: { onAdd: OnAdd; onError: (message: string) => void }) {
  const { value, setValue, busy, submit } = useAddRoom(onAdd, onError);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative hidden max-w-xs flex-1 md:block"
    >
      <input
        {...inputProps}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        aria-label="Add room"
        className={`${INPUT_CLASS} py-1.5`}
      />
    </form>
  );
}

// Mobile: modal sheet, same markup as zscraper's mobile search.
export function AddRoomDialog({ onAdd, onClose }: { onAdd: OnAdd; onClose: () => void }) {
  const { value, setValue, busy, error, submit } = useAddRoom(onAdd);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[calc(1rem_+_env(safe-area-inset-top))]"
      onClick={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await submit()) onClose();
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-stone-900"
      >
        <input
          {...inputProps}
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          aria-label="Add room"
          className={`${INPUT_CLASS} py-2`}
        />
        {error && <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="rounded bg-stone-800 px-3 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-200 dark:text-stone-900 dark:hover:bg-stone-300"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
