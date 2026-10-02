import { useEffect, useState } from "react";
import type { TipEvent } from "../api";
import { onServerEvent } from "../events";

// Tip alerts: newest at the bottom, each fading out after TIP_MS (the fade is
// CSS, see .tip-alert). A burst of tips stacks up, which is the point: it
// shows the room's momentum.
const TIP_MS = 6_000;
let tipSeq = 0;

type Alert = TipEvent & { id: number };

// Live tips for one room, newest last, at most `max` at a time.
export function useTipAlerts(username: string, max: number): Alert[] {
  const [tips, setTips] = useState<Alert[]>([]);
  useEffect(() => {
    setTips([]);
    return onServerEvent<TipEvent>("tip", (tip) => {
      if (tip.username !== username) return;
      const id = ++tipSeq;
      setTips((prev) => [...prev.slice(-(max - 1)), { ...tip, id }]);
      setTimeout(() => setTips((prev) => prev.filter((t) => t.id !== id)), TIP_MS);
    });
  }, [username, max]);
  return tips;
}

function TipAlert({ tip, compact }: { tip: TipEvent; compact: boolean }) {
  const size = compact ? "text-xs" : tip.amount >= 500 ? "text-base" : "text-sm";
  const tier =
    tip.amount >= 500
      ? "bg-orange-600/90 ring-orange-300/50"
      : tip.amount >= 100
        ? "bg-amber-500/85 ring-amber-200/40"
        : "bg-black/60 ring-white/20";
  return (
    <div
      className={`tip-alert w-fit max-w-full rounded-lg text-white shadow-lg ring-1 backdrop-blur-sm ${
        compact ? "px-2 py-1" : "px-2.5 py-1.5"
      } ${size} ${tier}`}
    >
      <p className="truncate">
        <span className="font-semibold tabular-nums">🪙 {tip.amount.toLocaleString()}</span>{" "}
        <span className="opacity-90">{tip.from ?? "Anonymous"}</span>
      </p>
      {tip.message && !compact && <p className="mt-0.5 truncate text-xs opacity-80">{tip.message}</p>}
    </div>
  );
}

// Absolutely positioned at the top-left of its (relative) container.
export function TipAlertStack({ tips, compact = false }: { tips: Alert[]; compact?: boolean }) {
  if (!tips.length) return null;
  return (
    <div
      className={`pointer-events-none absolute flex flex-col items-start gap-1.5 ${
        compact ? "left-2 top-2 max-w-[75%]" : "left-3 top-3 max-w-[60vw] sm:max-w-sm"
      }`}
    >
      {tips.map((t) => (
        <TipAlert key={t.id} tip={t} compact={compact} />
      ))}
    </div>
  );
}
