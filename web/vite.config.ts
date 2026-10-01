import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Served at the root of its own host (https://cb.sing.sh) behind the central Caddy.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // New build's SW takes over on the next launch — no update prompt, no stale shell.
      registerType: "autoUpdate",
      injectRegister: "auto",
      // We ship our own manifest.webmanifest + icons + Apple splash links (index.html).
      manifest: false,
      includeManifestIcons: false,
      workbox: {
        // Precache the app shell so launches paint from disk instead of the network.
        // API responses and room thumbnails are live data and are never cached.
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      // Keep the SW out of `vite dev` so it doesn't cache during development.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
