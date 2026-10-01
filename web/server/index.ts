import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "rooms.json");

// Background poller tuning
const POLL_INTERVAL_MS = 30_000;
const POLL_CONCURRENCY = 4;
const REQUEST_JITTER_MS = 250;
const MAX_BACKOFF_MS = 10 * 60_000;

app.use(express.json());

// Types
interface Room {
  id: number;
  username: string;
  added_at: string;
  // Live history, persisted so it survives restarts. Written only on
  // live/not-live transitions, not every poll.
  live_since?: string | null;
  last_live_at?: string | null;
}

interface RoomStatus {
  username: string;
  isLive: boolean;
  // Upstream room_status ("public", "private", "away", "hidden", "offline", ...)
  // plus our own: "not_found" (no such room), "error" (never checked
  // successfully), "unknown" (not checked yet).
  roomStatus: string;
  checkedAt: string | null;
  liveSince: string | null;
  lastLiveAt: string | null;
}

type Check = Pick<RoomStatus, "username" | "isLive" | "roomStatus" | "checkedAt">;

// --- Storage -----------------------------------------------------------------
// Rooms live in memory; the file is only read at startup. A corrupt file is a
// hard error (the container crash-loops and says why) rather than being
// treated as empty — that used to let the next add overwrite the whole list.

function loadRooms(): Room[] {
  let raw: string;
  try {
    raw = readFileSync(DB_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${DB_FILE}: expected an array`);
  return parsed;
}

// Write to a temp file then rename over the original, so a crash mid-write
// (or a backup reading mid-write) never sees a truncated file.
function saveRooms(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(rooms, null, 2), "utf-8");
  renameSync(tmp, DB_FILE);
}

let rooms: Room[];
try {
  rooms = loadRooms();
} catch (err) {
  console.error(`FATAL: cannot read ${DB_FILE} — refusing to start so it isn't overwritten.`, err);
  process.exit(1);
}

// --- Username handling -------------------------------------------------------

const USERNAME_RE = /^[a-z0-9_]{1,64}$/;

// Accepts a bare username or a pasted room URL ("https://chaturbate.com/foo/").
// Returns null if the result isn't a plausible username.
function normalizeUsername(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?chaturbate\.com\//, "")
    .replace(/\/+$/, "");
  return USERNAME_RE.test(name) ? name : null;
}

// --- Upstream status checks --------------------------------------------------

class RateLimitedError extends Error {
  constructor(public retryAfterMs: number | null) {
    super("rate limited");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns a fresh status, or throws on transient failures (network, timeout,
// 5xx, non-JSON challenge pages) so the caller can keep the last good value.
async function fetchRoomStatus(username: string): Promise<Check> {
  const response = await fetch(`https://chaturbate.com/api/chatvideocontext/${username}/`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  const checkedAt = new Date().toISOString();

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
  }
  if (response.status === 404) {
    return { username, isLive: false, roomStatus: "not_found", checkedAt };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    username,
    isLive: data.room_status === "public",
    roomStatus: data.room_status || "unknown",
    checkedAt,
  };
}

// --- Background poller -------------------------------------------------------
// One server-side loop checks every room on an interval, a few at a time, and
// caches the results. API reads come from the cache, so clients never wait on
// (or multiply) upstream requests.

const statusCache = new Map<string, Check>();
// Last poll time each room was seen live (in memory; feeds last_live_at).
const lastSeenLive = new Map<string, string>();
let backoffUntil = 0;
let backoffMs = 0;
let lastPollAt: string | null = null;
let pollTimer: NodeJS.Timeout | undefined;
let pollInFlight: Promise<void> | null = null;
let stopping = false;

async function checkAndCache(username: string): Promise<void> {
  try {
    const check = await fetchRoomStatus(username);
    statusCache.set(username, check);
    recordLiveTransition(check);
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    console.warn(`status check failed for ${username}:`, (err as Error).message);
    // Keep the last good status; only record an error if we have nothing.
    if (!statusCache.has(username)) {
      statusCache.set(username, { username, isLive: false, roomStatus: "error", checkedAt: null });
    }
  }
}

function recordLiveTransition(check: Check): void {
  const room = rooms.find((r) => r.username === check.username);
  if (!room) return; // removed while the check was in flight, or not saved

  const wasLive = Boolean(room.live_since);
  if (check.isLive) {
    lastSeenLive.set(room.username, check.checkedAt!);
    if (!wasLive) {
      room.live_since = check.checkedAt;
      saveRooms();
    }
  } else if (wasLive) {
    // If we restarted mid-stream we never saw it live this process; the start
    // of the stream is the best lower bound we have.
    room.last_live_at = lastSeenLive.get(room.username) ?? room.live_since;
    room.live_since = null;
    saveRooms();
  }
}

// Shared by the loop and manual refreshes so they never overlap.
function pollAll(): Promise<void> {
  pollInFlight ??= runPoll().finally(() => {
    pollInFlight = null;
  });
  return pollInFlight;
}

async function runPoll(): Promise<void> {
  if (Date.now() < backoffUntil) return;

  const queue = rooms.map((r) => r.username);
  let rateLimited: RateLimitedError | null = null;

  const worker = async () => {
    while (queue.length && !rateLimited && !stopping) {
      const username = queue.shift()!;
      try {
        await checkAndCache(username);
      } catch (err) {
        rateLimited = err as RateLimitedError;
        break;
      }
      await sleep(Math.random() * REQUEST_JITTER_MS);
    }
  };
  await Promise.all(Array.from({ length: POLL_CONCURRENCY }, worker));

  if (rateLimited) {
    const { retryAfterMs } = rateLimited as RateLimitedError;
    backoffMs = retryAfterMs ?? Math.min(Math.max(backoffMs * 2, POLL_INTERVAL_MS), MAX_BACKOFF_MS);
    backoffUntil = Date.now() + backoffMs;
    console.warn(`rate limited upstream; backing off ${Math.round(backoffMs / 1000)}s`);
  } else {
    backoffMs = 0;
    lastPollAt = new Date().toISOString();
  }
}

async function pollLoop(): Promise<void> {
  try {
    await pollAll();
  } catch (err) {
    console.error("poll cycle failed:", err);
  }
  if (!stopping) pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
}

function roomStatus(room: Room): RoomStatus {
  const check = statusCache.get(room.username) ?? {
    username: room.username,
    isLive: false,
    roomStatus: "unknown",
    checkedAt: null,
  };
  return { ...check, liveSince: room.live_since ?? null, lastLiveAt: room.last_live_at ?? null };
}

// --- API routes --------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.length, lastPollAt, backoffUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null });
});

// Get all saved rooms
app.get("/api/rooms", (_req, res) => {
  res.json(rooms);
});

// Add a room
app.post("/api/rooms", (req, res) => {
  const { username } = req.body ?? {};
  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "username is required" });
    return;
  }

  const normalized = normalizeUsername(username);
  if (!normalized) {
    res.status(400).json({ error: "Invalid username (letters, numbers and _ only)" });
    return;
  }

  if (rooms.some((r) => r.username === normalized)) {
    res.status(409).json({ error: "Room already saved" });
    return;
  }

  const newRoom: Room = {
    id: Math.max(Date.now(), ...rooms.map((r) => r.id + 1)),
    username: normalized,
    added_at: new Date().toISOString(),
  };

  rooms.push(newRoom);
  saveRooms();

  // Check the new room right away rather than waiting for the next cycle.
  if (Date.now() >= backoffUntil) checkAndCache(normalized).catch(() => {});

  res.status(201).json(newRoom);
});

// Delete a room
app.delete("/api/rooms/:id", (req, res) => {
  const id = Number(req.params.id);
  const index = rooms.findIndex((r) => r.id === id);

  if (index === -1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const [removed] = rooms.splice(index, 1);
  saveRooms();
  statusCache.delete(removed.username);
  lastSeenLive.delete(removed.username);

  res.json({ success: true });
});

// Status of all saved rooms (from the poller's cache)
app.get("/api/rooms/status", (_req, res) => {
  res.json(rooms.map(roomStatus));
});

// Force a poll now (debounced), then return fresh statuses
app.post("/api/rooms/refresh", async (_req, res) => {
  const recentlyPolled = lastPollAt && Date.now() - Date.parse(lastPollAt) < 5000;
  if (!recentlyPolled) await pollAll();
  res.json(rooms.map(roomStatus));
});

// Status of a single room: cached if saved, otherwise checked live
app.get("/api/rooms/:username/status", async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) {
    res.status(400).json({ error: "Invalid username" });
    return;
  }
  const room = rooms.find((r) => r.username === username);
  if (room) {
    res.json(roomStatus(room));
    return;
  }
  try {
    res.json({ ...(await fetchRoomStatus(username)), liveSince: null, lastLiveAt: null });
  } catch (err) {
    const status = err instanceof RateLimitedError ? 429 : 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

// Unknown API paths are a 404, not the SPA shell
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Serve static files in production
const distPath = path.join(__dirname, "..", "dist");
app.use(
  express.static(distPath, {
    // Vite's hashed bundles never change; everything else (index.html, sw.js,
    // manifest) revalidates so a redeploy is picked up straight away.
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);
app.use((_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`CB Checker server running on http://localhost:${PORT} (data: ${DATA_DIR}, ${rooms.length} rooms)`);
  pollLoop();
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopping = true;
  clearTimeout(pollTimer);
  server.close(() => process.exit(0));
  // Don't let in-flight upstream requests hold the exit hostage.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
