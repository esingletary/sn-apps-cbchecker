# CB Checker

A self-hosted Chaturbate room tracker. Save your favorite rooms and check at a glance whether they are live.

## Features

- **Save rooms** -- Add a username or paste a room link
- **Live status at a glance** -- Live rooms first (busiest first) with a live thumbnail, viewer count and "live for 23m"; private/group/ticket shows shown distinctly; offline rooms sorted by "last live 3h ago" and hidden unless "Show offline" is on
- **Instant updates** -- Status, title and tip events arrive over Chaturbate's own realtime push and stream to the browser; a slow background poll backs it up
- **Hover preview** -- Rest the pointer on a live card for a muted live preview; clicking carries the same stream into the full player
- **Multi-view** -- Up to 2×2 live rooms at once, filled with the busiest; tap a tile for its sound, swap rooms from a thumbnail picker, expand one to the full player and come back. Rooms that go private/offline are replaced automatically
- **Watch in-app** -- Full-screen player with viewer count, room title, live tip alerts, and ←/→ (or swipe) to flip between live rooms; cmd/ctrl-click still opens the site
- **Busy hint** -- 🔥 on live cards whose room has seen 100+ tokens tipped in the last 5 minutes
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
│   │   ├── index.ts          # Express server, JSON storage, status poller, /api/events
│   │   └── push.ts           # Chaturbate realtime push (status/title/tips)
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
| `GET` | `/api/health` | Health check (room count, last check, current request gap, approx. per-room refresh time, rate-limit pause, push state) |
| `GET` | `/api/events` | Server-sent events: `status` (a room's status, on every change/check) and `tip` (`{ username, amount, from, message }`) |
| `GET` | `/api/rooms/:username/stream` | Fresh tokenised HLS URL (`409` if not in a public show) |
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

1. **Push.** The server opens one connection to Chaturbate's realtime push service (Ably, as their room page uses it) and subscribes every saved room to its status, title and tip topics, keyed by the room's broadcaster uid (learned from the first poll and stored in `rooms.json`). Status changes land within a second. Push is undocumented, so it's watched: a failed connection or channel retries with backoff, and if polls keep finding status changes push never delivered, the connection is rebuilt. Polls don't overrule a status push delivered in the last 90s, since the polled API can lag.
2. **Polling.** A background loop on the server calls Chaturbate's `chatvideocontext` API for one room at a time, least recently checked first, and caches the results. Chaturbate rate-limits per IP (HTTP 429, no limit headers), so the gap between requests adapts: it starts at 4s, doubles on a 429 (with a 30s pause), and shrinks 15% after every 30 successes, down to 2s. It never goes faster than needed to check each room every 30s, or every 3 minutes while push is connected (then it only refreshes viewer counts and photos, and backstops push). `GET /api/health` shows the current pace.
   Last known statuses are saved to `data/status.json` (every minute and on shutdown), so a restart doesn't reset every room to "Checking…".
3. Transient failures (timeouts, 5xx, challenge pages) keep the last good status instead of flipping the room to offline. A 404 is reported as `not_found`.
4. `GET /api/rooms/status` answers instantly from the cache, so any number of open tabs cost no extra upstream requests.
5. Live/offline transitions are written to `rooms.json` (`live_since`, `last_live_at`) so history survives restarts.
6. The frontend gets changes over `/api/events` as they happen, and re-reads the cache every 60 seconds while visible (and after the event stream reconnects) as a backstop.

### In-app playback

`chatvideocontext` includes `hls_source`, a tokenised LL-HLS playlist on the
CDN. Each URL is good for **one playback session**: a second load of its
playlist gets `403 session_duplicated`, so it's never cached or reused. The
player (or hover preview) asks the server for a fresh one each time, then plays **straight from the CDN** —
playlists and fMP4 segments are served with `Access-Control-Allow-Origin: *`,
so no video goes through this server. Safari/iOS play HLS natively; other
browsers load `hls.js` on demand (kept out of the main bundle and the PWA
precache). On a fatal error the player fetches a new token and reconnects (up
to twice) before showing "stream stopped". A hover preview's `<video>` and
hls.js instance live outside React (`src/liveStream.ts`), so clicking the card
moves that same element into the player instead of opening a second session.

If the token turns out to be bound to the requesting IP, playback can fail on
devices whose public IP differs from the server's (e.g. on Tailscale away from
home without an exit node).

Home-screen icons and iOS launch screens are generated from `web/src/images/logo-mark.svg` by `pnpm --filter web gen:icons`.

## License

MIT
