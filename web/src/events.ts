// One shared /api/events stream for the whole app, opened on first use. The
// browser reconnects it by itself; "open" fires again after each reconnect, so
// listeners can catch up on anything missed while it was down.
let source: EventSource | null = null;
const listening = new Set<string>();
const handlers = new Map<string, Set<(data: unknown) => void>>();

export function onServerEvent<T>(type: string, handler: (data: T) => void): () => void {
  source ??= new EventSource("/api/events");
  if (!listening.has(type)) {
    listening.add(type);
    source.addEventListener(type, (e) => {
      const raw = (e as MessageEvent).data;
      let data: unknown = null;
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
      }
      handlers.get(type)?.forEach((h) => h(data));
    });
  }
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  const h = handler as (data: unknown) => void;
  set.add(h);
  return () => {
    set.delete(h);
  };
}
