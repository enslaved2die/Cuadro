import fs from "node:fs";
import path from "node:path";

export const EPD_WIDTH = 1200;
export const EPD_HEIGHT = 1600;
export const TOTAL_PIXELS = EPD_WIDTH * EPD_HEIGHT; // 1,920,000
export const BUFFER_SIZE_BYTES = TOTAL_PIXELS / 2;   // exactly 960,000 bytes

/**
 * Packs 1,920,000 4-bit indexed pixels into a 960,000-byte binary buffer
 * matching Good Display GDEB0709E01 binary format.
 */
export function pack4BitPixels(pixels: Uint8Array): Buffer {
  if (pixels.length !== TOTAL_PIXELS) {
    throw new Error(
      `Invalid pixel count: expected ${TOTAL_PIXELS} (1200x1600), got ${pixels.length}`
    );
  }

  const buffer = Buffer.alloc(BUFFER_SIZE_BYTES);

  for (let i = 0; i < BUFFER_SIZE_BYTES; i++) {
    const p0 = pixels[i * 2] & 0x0f;
    const p1 = pixels[i * 2 + 1] & 0x0f;
    buffer[i] = (p0 << 4) | p1;
  }

  return buffer;
}

/**
 * Generates a pre-baked 960,000-byte pure white buffer (0x11) for Storage / Vacation Mode.
 * This guarantees panel particle reset and zero degradation during prolonged idle periods.
 */
export function generatePureWhiteBuffer(): Buffer {
  const buffer = Buffer.alloc(BUFFER_SIZE_BYTES, 0x11);
  return buffer;
}

/**
 * Generates a vertical 6-band color bar test pattern (Black, White, Yellow, Red, Blue, Green).
 * Useful for bring-up, diagnostics, and panel color calibration.
 */
export function generateTestColorBars(): Buffer {
  const bars = [0x0, 0x1, 0x2, 0x3, 0x5, 0x6];
  const pixels = new Uint8Array(TOTAL_PIXELS);

  const bandWidth = Math.floor(EPD_WIDTH / bars.length); // 200 pixels per band

  for (let y = 0; y < EPD_HEIGHT; y++) {
    for (let x = 0; x < EPD_WIDTH; x++) {
      const bandIdx = Math.min(Math.floor(x / bandWidth), bars.length - 1);
      pixels[y * EPD_WIDTH + x] = bars[bandIdx];
    }
  }

  return pack4BitPixels(pixels);
}

/**
 * Saves a buffer to disk and verifies exact byte count.
 */
export async function writeFrameBinary(filePath: string, buffer: Buffer): Promise<void> {
  if (buffer.length !== BUFFER_SIZE_BYTES) {
    throw new Error(
      `Invalid frame buffer length: expected ${BUFFER_SIZE_BYTES} bytes, got ${buffer.length}`
    );
  }
  await fs.promises.writeFile(filePath, buffer);
}

/**
 * Deletes cached rendered .bin files from cacheDir (while preserving *_orig.jpg and *_thumb.jpg)
 * so that subsequent frame polls or reprocess runs dynamically render fresh binaries instead of
 * serving stale pre-rendered files.
 */
export async function purgeCachedBinaries(cacheDir: string, photoId?: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(cacheDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".bin")) continue;
    if (photoId && entry !== `${photoId}.bin` && !entry.startsWith(`${photoId}_`)) continue;
    try {
      await fs.promises.rm(path.join(cacheDir, entry), { force: true });
      removed++;
    } catch {
      // Ignore concurrent deletion errors
    }
  }
  return removed;
}

export function purgeCachedBinariesSync(cacheDir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".bin")) continue;
    try {
      fs.rmSync(path.join(cacheDir, entry), { force: true });
      removed++;
    } catch {
      // Ignore errors
    }
  }
  return removed;
}
