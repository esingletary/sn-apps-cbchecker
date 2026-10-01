import express from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const DB_PATH = path.join(__dirname, "..", "data", "rooms.db");

app.use(express.json());

// Initialize SQLite
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  )
`);

// Types
interface Room {
  id: number;
  username: string;
  added_at: string;
}

interface RoomStatus {
  username: string;
  isLive: boolean;
  roomStatus: string;
  url: string | null;
}

// API Routes

// Get all saved rooms
app.get("/api/rooms", (_req, res) => {
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY added_at DESC").all();
  res.json(rooms);
});

// Add a room
app.post("/api/rooms", (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "username is required" });
    return;
  }

  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    res.status(400).json({ error: "username cannot be empty" });
    return;
  }

  try {
    const result = db
      .prepare("INSERT INTO rooms (username) VALUES (?)")
      .run(normalized);
    const room = db
      .prepare("SELECT * FROM rooms WHERE id = ?")
      .get(result.lastInsertRowid);
    res.status(201).json(room);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Room already saved" });
      return;
    }
    throw err;
  }
});

// Delete a room
app.delete("/api/rooms/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.json({ success: true });
});

// Check status of all rooms (batch)
app.get("/api/rooms/status", async (_req, res) => {
  const rooms = db.prepare("SELECT * FROM rooms").all() as Room[];
  const statuses = await Promise.all(rooms.map(checkRoomStatus));
  res.json(statuses);
});

// Check status of a single room
app.get("/api/rooms/:username/status", async (req, res) => {
  const username = req.params.username.toLowerCase();
  const status = await checkRoomStatus({ username } as Room);
  res.json(status);
});

// Check room status from Chaturbate
async function checkRoomStatus(room: Room): Promise<RoomStatus> {
  try {
    const response = await fetch(
      `https://chaturbate.com/api/chatvideocontext/${room.username}/`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      return {
        username: room.username,
        isLive: false,
        roomStatus: "offline",
        url: null,
      };
    }

    const data = await response.json();

    return {
      username: room.username,
      isLive: data.room_status === "public",
      roomStatus: data.room_status || "unknown",
      url: data.url || null,
    };
  } catch {
    return {
      username: room.username,
      isLive: false,
      roomStatus: "error",
      url: null,
    };
  }
}

// Serve static files in production
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`CB Checker server running on http://localhost:${PORT}`);
});
