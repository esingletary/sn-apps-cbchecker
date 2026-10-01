// Regenerate the home-screen / favicon / iOS splash assets from the logo mark.
// Run with: pnpm --filter web gen:icons  (then paste the printed splash tags
// into index.html if the device list changed).
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SRC = fs.readFileSync(path.join(root, "src/images/logo-mark.svg"), "utf-8");
const PUBLIC = path.join(root, "public");
const BG = "#0c0a09"; // stone-950, matches the dark UI and theme_color

// Home-screen icons are full-bleed: the OS applies its own corner mask.
const SQUARE = SRC.replace(/rx="\d+"/, 'rx="0"');

const render = (svg, size) => sharp(Buffer.from(svg), { density: 72 * (size / 64) * 2 }).resize(size, size).png();

async function icon(svg, size, out) {
  await render(svg, size).toFile(path.join(PUBLIC, out));
  console.log("wrote", out);
}

// Maskable: keep the mark inside the ~80% safe zone on an orange field.
async function maskable(size, out) {
  const inner = Math.round(size * 0.7);
  const mark = await render(SQUARE, inner).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: "#ea580c" } })
    .composite([{ input: mark, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) }])
    .png()
    .toFile(path.join(PUBLIC, out));
  console.log("wrote", out);
}

fs.mkdirSync(PUBLIC, { recursive: true });
await icon(SQUARE, 192, "icon-192.png");
await icon(SQUARE, 512, "icon-512.png");
await maskable(512, "icon-maskable-512.png");
await icon(SQUARE, 180, "apple-touch-icon.png");
await icon(SRC, 32, "favicon-32.png");
await icon(SRC, 16, "favicon-16.png");

// iOS launch screens. iOS only shows an apple-touch-startup-image whose media
// query exactly matches the device, so emit one per common iPhone [cssW, cssH, dpr].
const SPLASH = [
  [440, 956, 3], // 16/17 Pro Max
  [430, 932, 3], // 14/15 Pro Max, 15/16 Plus
  [402, 874, 3], // 16/17 Pro
  [393, 852, 3], // 14/15/16 Pro, 15/16
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [390, 844, 3], // 12/13/14, 15
  [375, 812, 3], // X/XS/11 Pro, 12/13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [375, 667, 2], // SE, 8
  [414, 736, 3], // 8 Plus
];
const SPLASH_DIR = path.join(PUBLIC, "splash");
fs.mkdirSync(SPLASH_DIR, { recursive: true });
const tags = [];
for (const [cssW, cssH, dpr] of SPLASH) {
  const w = cssW * dpr;
  const h = cssH * dpr;
  const markSize = 96 * dpr;
  const mark = await render(SRC, markSize).toBuffer();
  const file = `splash-${w}x${h}.png`;
  await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
    .composite([{ input: mark, top: Math.round((h - markSize) / 2), left: Math.round((w - markSize) / 2) }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(SPLASH_DIR, file));
  tags.push(
    `    <link rel="apple-touch-startup-image" media="screen and (device-width: ${cssW}px) and (device-height: ${cssH}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="/splash/${file}" />`
  );
}
console.log("wrote", SPLASH.length, "splash images");
console.log("\n--- paste into index.html <head> ---\n" + tags.join("\n") + "\n");
