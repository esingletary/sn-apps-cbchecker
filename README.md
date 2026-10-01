# CB Checker

A self-hosted Chaturbate room tracker. Save your favorite rooms and check at a glance whether they are live.

## Features

- **Save rooms** -- Add any Chaturbate username to your watchlist
- **Live status** -- See which rooms are currently broadcasting (auto-refreshes every 30 seconds)
- **Quick links** -- Click through to any room directly
- **Persistent storage** -- Rooms are saved in a local SQLite database
- **Lightweight** -- Single Express server + React SPA, no external services required

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 6, Tailwind CSS 4 |
| Backend | Express 5, TypeScript |
| Storage | SQLite via `better-sqlite3` |
| Language | TypeScript (strict mode) |

## Project Structure

```
cbchecker/
├── package.json              # Root scripts (dev, build, start)
├── web/
│   ├── package.json
│   ├── vite.config.ts        # Vite + React + Tailwind + API proxy
│   ├── tsconfig.json         # Frontend TS config
│   ├── tsconfig.server.json  # Backend TS config
│   ├── index.html
│   ├── server/
│   │   └── index.ts          # Express server + SQLite + Chaturbate API client
│   └── src/
│       ├── main.tsx          # React entry point
│       ├── App.tsx           # Routes
│       ├── index.css         # Tailwind entry
│       ├── api.ts            # Typed API client functions
│       ├── components/
│       │   ├── Layout.tsx        # App shell (header, nav)
│       │   ├── RoomCard.tsx      # Single room status card
│       │   └── AddRoomForm.tsx   # Username input form
│       └── pages/
│           └── Dashboard.tsx     # Main page (room grid + add form)
└── data/                     # SQLite database (created at runtime)
```

## Getting Started

### Prerequisites

- Node.js 22+ and npm

### Install & Run

```bash
cd cbchecker
npm install
npm run dev
```

The frontend dev server starts on `http://localhost:5173` and the API server on `http://localhost:3001`. Vite proxies `/api` requests to the backend automatically.

### Production Build

```bash
npm run build
npm start
```

This compiles the React frontend to `web/dist/` and the Express server to `web/server-dist/`. The server serves both the static files and the API from port 3001.

## API Reference

All endpoints are prefixed with `/api`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rooms` | List all saved rooms |
| `POST` | `/api/rooms` | Add a room -- body: `{ "username": "example_model" }` |
| `DELETE` | `/api/rooms/:id` | Remove a room by ID |
| `GET` | `/api/rooms/status` | Get live status for all saved rooms |
| `GET` | `/api/rooms/:username/status` | Get live status for a single room |

### Status Response Shape

```json
{
  "username": "example_model",
  "isLive": true,
  "roomStatus": "public",
  "url": "https://edge17-hel.live.mmcdn.com/live-hls/..."
}
```

- `isLive` is `true` when `roomStatus` is `"public"`
- `roomStatus` can be `"public"` (live), `"private"`, `"offline"`, or `"error"`

## How It Works

1. The frontend calls `GET /api/rooms/status` to fetch all saved rooms and their current broadcast status.
2. The Express server queries the SQLite database for saved rooms, then calls Chaturbate's `chatvideocontext` API for each username to determine if the room is live.
3. Results are returned as JSON and rendered as a grid of room cards.
4. The frontend polls the status endpoint every 30 seconds to keep the UI up to date.

## License

MIT
