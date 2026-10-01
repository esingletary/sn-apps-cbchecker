import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "rooms.json");

app.use(express.json());

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

// JSON file storage helpers
function loadRooms(): Room[] {
  if (!existsSync(DB_FILE)) return [];
  try {
    const raw = readFileSync(DB_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRooms(rooms: Room[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_FILE, JSON.stringify(rooms, null, 2), "utf-8");
}

// API Routes

// Get all saved rooms
app.get("/api/rooms", (_req, res) => {
  const rooms = loadRooms();
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

  const rooms = loadRooms();

  if (rooms.some((r) => r.username === normalized)) {
    res.status(409).json({ error: "Room already saved" });
    return;
  }

  const newRoom: Room = {
    id: Date.now(),
    username: normalized,
    added_at: new Date().toISOString(),
  };

  rooms.push(newRoom);
  saveRooms(rooms);

  res.status(201).json(newRoom);
});

// Delete a room
app.delete("/api/rooms/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rooms = loadRooms();
  const index = rooms.findIndex((r) => r.id === id);

  if (index === -1) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  rooms.splice(index, 1);
  saveRooms(rooms);

  res.json({ success: true });
});

// Check status of all rooms (batch)
app.get("/api/rooms/status", async (_req, res) => {
  const rooms = loadRooms();
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
