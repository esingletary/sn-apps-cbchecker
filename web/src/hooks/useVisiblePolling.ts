import { useEffect, useRef } from "react";

// Calls `fn` every `intervalMs` while the page is visible. Stops when the tab
// is hidden (or the PWA is backgrounded) and runs immediately on return.
export function useVisiblePolling(fn: () => void, intervalMs: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(id);
      fnRef.current();
      id = setInterval(() => fnRef.current(), intervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else clearInterval(id);
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
