import { useEffect } from "react";

export interface ToastData {
  id: number;
  message: string;
  tone?: "default" | "error";
  actionLabel?: string;
  onAction?: () => void;
}

export default function Toast({ toast, durationMs, onDismiss }: { toast: ToastData | null; durationMs: number; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
  }, [toast, durationMs, onDismiss]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem_+_env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
      <div
        role="status"
        className={`pointer-events-auto flex items-center gap-4 rounded-lg px-4 py-2.5 text-sm shadow-xl ring-1 ${
          toast.tone === "error"
            ? "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900"
            : "bg-stone-800 text-stone-100 ring-stone-700 dark:bg-stone-800"
        }`}
      >
        <span>{toast.message}</span>
        {toast.actionLabel && (
          <button
            type="button"
            onClick={toast.onAction}
            className="font-medium text-orange-400 hover:text-orange-300"
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
