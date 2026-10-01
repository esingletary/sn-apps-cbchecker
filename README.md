# CB Checker

A self-hosted Chaturbate room tracker. Save your favorite rooms and check at a glance whether they are live.

## Features

- **Save rooms** -- Add a username or paste a room link
- **Live status at a glance** -- Live rooms first with a live thumbnail and "live for 23m"; private/group/away shown distinctly; offline rooms sorted by "last live 3h ago"
- **Server-side checks** -- One background poller (every 30s) no matter how many tabs are open; "↻" forces a check now
- **Undo** -- Removing a room can be undone for 5 seconds
- **Installable PWA** -- Add to home screen on iOS/Android; app shell is precached
- **Lightweight** -- Single Express server + React SPA, JSON file storage

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 6, Tailwind CSS 4, vite-plugin-pwa |
| Backend | Express 5, TypeScript |
| Storage | JSON file (`data/rooms.json`) |
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
│   │   └── index.ts          # Express server, JSON storage, background status poller
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
└── data/
    └── rooms.json            # Room storage (created at runtime)
```

## Getting Started

### Prerequisites

- Node.js 22+ and pnpm

### Install & Run

```bash
cd cbchecker
pnpm install
pnpm dev
```

The frontend dev server starts on `http://localhost:5173` and the API server on `http://localhost:3001`. Vite proxies `/api` requests to the backend automatically.

### Deploy (SingNet)

Runs as a Docker stack behind the central Caddy (`/opt/stacks/caddy`) at
**https://cb.sing.sh**, over the shared external `proxy` network. The watchlist
lives in `./data/rooms.json` (bind-mounted at `/data`).

```bash
pnpm deploy   # docker compose up -d --build
```

If `rooms.json` is unreadable the server refuses to start (rather than
treating it as empty and overwriting it) — check `docker logs cbchecker`.

### Production Build

```bash
pnpm build
pnpm start
```

This compiles the React frontend to `web/dist/` and the Express server to `web/server-dist/`. The server serves both the static files and the API from port 3001.

## API Reference

All endpoints are prefixed with `/api`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rooms` | List all saved rooms |
| `POST` | `/api/rooms` | Add a room -- body: `{ "username": "example_model" }` |
| `DELETE` | `/api/rooms/:id` | Remove a room by ID |
| `GET` | `/api/rooms/status` | Cached status for all saved rooms (from the background poller) |
| `POST` | `/api/rooms/refresh` | Poll upstream now (debounced to 5s), return fresh statuses |
| `GET` | `/api/health` | Health check (room count, last poll time, rate-limit backoff) |
| `GET` | `/api/rooms/:username/status` | Get live status for a single room |

### Status Response Shape

```json
{
  "username": "example_model",
  "isLive": true,
  "roomStatus": "public",
  "checkedAt": "2026-10-01T05:12:46.834Z",
  "liveSince": "2026-10-01T04:50:02.112Z",
  "lastLiveAt": null
}
```

- `isLive` is `true` when `roomStatus` is `"public"`
- `roomStatus` is the upstream value (`"public"`, `"private"`, `"away"`, `"hidden"`, `"offline"`, …) or one of `"not_found"`, `"error"` (never checked successfully), `"unknown"` (not checked yet)

## How It Works

1. A background loop on the server calls Chaturbate's `chatvideocontext` API for each saved room every 30 seconds (4 at a time, with jitter) and caches the results. On HTTP 429 it backs off (honouring `Retry-After`, otherwise exponential up to 10 min).
2. Transient failures (timeouts, 5xx, challenge pages) keep the last good status instead of flipping the room to offline. A 404 is reported as `not_found`.
3. `GET /api/rooms/status` answers instantly from the cache, so any number of open tabs cost no extra upstream requests.
4. Live/offline transitions are written to `rooms.json` (`live_since`, `last_live_at`) so history survives restarts.
5. The frontend reads the cache every 15 seconds while visible, and pauses when the tab or PWA is in the background.

Home-screen icons and iOS launch screens are generated from `web/src/images/logo-mark.svg` by `pnpm --filter web gen:icons`.

## License

MIT
