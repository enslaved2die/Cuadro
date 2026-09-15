import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cron from "node-cron";
import sharp from "sharp";
import { ImmichAdapter, ImmichSourceConfig } from "../adapters/immich.js";
import { GooglePhotosAdapter, GooglePhotosSourceConfig } from "../adapters/google-photos.js";
import { ICloudAdapter, ICloudSourceConfig } from "../adapters/icloud.js";
import { AlbumAdapter, RemotePhoto } from "../adapters/base.js";
import { processImageToFrameBuffer, getImageAnalysis, ImageAnalysis } from "../pipeline/processor.js";
import { writeFrameBinary } from "../pipeline/packer.js";
import { getDb } from "../db/database.js";
import { enqueuePhoto, peekNextPhoto } from "./queue.js";
import { config } from "../config.js";

interface AlbumSourceRow {
  id: string;
  name: string;
  type: "google_photos" | "immich" | "icloud" | "manual";
  config_json: string;
  enabled: number;
}

// Builds the adapter for one `album_sources` row, passing its per-source config_json as the
// adapter's override (each adapter falls back to the global env-based config for any field
// left unset - see GooglePhotosSourceConfig et al.). This is what makes newly-created Album
// Sources (and the ones Phase 1's migration created from legacy global settings) actually
// syncable, instead of the previous fixed 3-adapter, global-config-only instantiation.
function buildAdapterForSource(row: AlbumSourceRow): AlbumAdapter | null {
  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(row.config_json) || {};
  } catch {
    cfg = {};
  }

  switch (row.type) {
    case "google_photos":
      return new GooglePhotosAdapter(cfg as GooglePhotosSourceConfig);
    case "immich":
      return new ImmichAdapter(cfg as ImmichSourceConfig);
    case "icloud":
      return new ICloudAdapter(cfg as ICloudSourceConfig);
    case "manual":
      // Manual sources are never polled - photos are tagged with their album_source_id
      // directly at upload time (see POST /api/v1/admin/upload's albumSourceId param).
      return null;
    default:
      return null;
  }
}

let isSyncRunning = false;

// Renders a downloaded photo's admin thumbnail + e-paper binary and writes them to disk.
// Shared by the eager (manual upload) and lazy (on-demand cloud download) paths - both end up
// with the same raw bytes to process once they have them.
async function renderPhotoAssets(
  photoId: string,
  rawBuffer: Buffer
): Promise<{ origPath: string; binPath: string; analysis: ImageAnalysis }> {
  const origPath = path.join(config.cacheDir, `${photoId}_orig.jpg`);
  const thumbPath = path.join(config.cacheDir, `${photoId}_thumb.jpg`);
  const binPath = path.join(config.cacheDir, `${photoId}_${config.frameOrientation}_${config.fitMode}.bin`);
  const legacyBinPath = path.join(config.cacheDir, `${photoId}.bin`);

  await fs.promises.writeFile(origPath, rawBuffer);

  const analysis = await getImageAnalysis(rawBuffer);
  console.log(
    `[PIPELINE] Analyzed photo ${photoId}: ${analysis.width}x${analysis.height} (${analysis.orientation.toUpperCase()}, AR ${analysis.aspectRatio})`
  );

  try {
    await sharp(rawBuffer).rotate().resize(320, 320, { fit: "inside" }).jpeg({ quality: 80 }).toFile(thumbPath);
  } catch (err) {
    console.warn(`[THUMB] Failed to generate thumbnail for ${photoId}:`, err);
  }

  console.log(`[PIPELINE] Rendering ${photoId} for frame ${config.frameOrientation} (mode: ${config.fitMode})...`);
  const frameBuffer = await processImageToFrameBuffer(rawBuffer, {
    frameOrientation: config.frameOrientation,
    fitMode: config.fitMode
  });
  await writeFrameBinary(binPath, frameBuffer);
  await writeFrameBinary(legacyBinPath, frameBuffer); // legacy alias

  return { origPath, binPath, analysis };
}

// Saves just a small preview (a few KB) for a cloud photo discovered during sync, WITHOUT
// downloading the full-resolution original or rendering an e-paper binary yet - that's
// deferred to ensurePhotoDownloaded, called only once the photo is actually about to be
// shown (or pre-warmed ahead of a frame's next expected refresh - see prewarmUpcomingPhotos).
// This is what keeps a large cloud album from eagerly filling local disk with every original.
async function registerPhotoPreview(photo: RemotePhoto, albumSourceId: string, adapter: AlbumAdapter): Promise<void> {
  const db = getDb();
  const thumbPath = path.join(config.cacheDir, `${photo.id}_thumb.jpg`);

  if (photo.previewUrl) {
    try {
      const previewBuffer = await adapter.downloadByUrl(photo.previewUrl);
      await sharp(previewBuffer).rotate().resize(320, 320, { fit: "inside" }).jpeg({ quality: 80 }).toFile(thumbPath);
    } catch (err) {
      console.warn(`[SYNC] Failed to fetch preview for ${photo.id} (will show as a placeholder until downloaded):`, err);
    }
  }

  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, orientation, uploaded_at, is_active, album_source_id, downloaded_at)
    VALUES (?, ?, ?, ?, '', '', 0, 0, 'unknown', ?, 1, ?, NULL)
  `).run(photo.id, photo.source, photo.sourceId, photo.originalUrl, now, albumSourceId);

  // Enqueue as high priority (10) so a newly-discovered photo still surfaces soon, same as
  // before this preview/lazy-download split - only the actual byte fetch is deferred.
  enqueuePhoto(photo.id, 10);
}

/**
 * Ensures a photo's full-resolution original and e-paper binary are actually on disk,
 * downloading and rendering them now if they aren't yet (`downloaded_at IS NULL`). Safe to
 * call redundantly - a no-op if already downloaded. Used both to pre-warm whatever's up next
 * for each frame ahead of time, and as a last-resort fallback at serve time if pre-warming
 * somehow didn't already cover it (e.g. a manual force-refresh landing seconds after a photo
 * was first discovered).
 */
export async function ensurePhotoDownloaded(photoId: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(photoId) as any;
  if (!row) return false;
  if (row.downloaded_at) return true; // already local

  const sourceRow = row.album_source_id
    ? (db.prepare("SELECT * FROM album_sources WHERE id = ?").get(row.album_source_id) as AlbumSourceRow | undefined)
    : undefined;
  const adapter = sourceRow ? buildAdapterForSource(sourceRow) : null;

  const download = async (url: string): Promise<Buffer> =>
    adapter ? adapter.downloadByUrl(url) : Buffer.from(await (await fetch(url)).arrayBuffer());

  let rawBuffer: Buffer;
  try {
    rawBuffer = await download(row.original_url);
  } catch (err) {
    // The captured URL may have expired (Google OAuth baseUrl and iCloud CDN links are both
    // time-limited). Re-sync just this source to refresh it, then retry once.
    if (!sourceRow || !adapter) {
      console.error(`[LAZY-DOWNLOAD] Failed to download ${photoId} and no source to refresh from:`, err);
      return false;
    }
    console.warn(`[LAZY-DOWNLOAD] Download failed for ${photoId}, re-syncing source "${sourceRow.name}" to refresh its URL...`, err);
    await syncOneSource(sourceRow);
    const refreshed = db.prepare("SELECT original_url FROM photos WHERE id = ?").get(photoId) as { original_url: string } | undefined;
    if (!refreshed) return false;
    try {
      rawBuffer = await download(refreshed.original_url);
    } catch (retryErr) {
      console.error(`[LAZY-DOWNLOAD] Retry download failed for ${photoId}:`, retryErr);
      return false;
    }
  }

  const { origPath, binPath, analysis } = await renderPhotoAssets(photoId, rawBuffer);
  db.prepare(`
    UPDATE photos SET file_path = ?, bin_path = ?, width = ?, height = ?, orientation = ?, downloaded_at = ?
    WHERE id = ?
  `).run(origPath, binPath, analysis.width, analysis.height, analysis.orientation, Date.now(), photoId);

  console.log(`[LAZY-DOWNLOAD] Fully downloaded and rendered ${photoId}.`);
  return true;
}

// Pre-fetches whatever peekNextPhoto would currently pick for every registered frame, so the
// real GET /next call a frame makes almost always finds an already-rendered binary instead of
// waiting on a live download. Run after every sync (periodic, "sync all now", per-frame sync,
// or a newly-created source's first sync) - frames sleep for hours between polls, so a photo
// discovered on one 15-minute sync tick is essentially always warmed well before it's needed.
export async function prewarmUpcomingPhotos(): Promise<void> {
  const db = getDb();
  const frames = db.prepare("SELECT id FROM frames").all() as Array<{ id: string }>;
  for (const frame of frames) {
    const next = peekNextPhoto(frame.id);
    if (next && !next.downloaded_at) {
      await ensurePhotoDownloaded(next.id).catch((err) =>
        console.error(`[PREWARM] Failed to pre-warm ${next.id} for frame ${frame.id}:`, err)
      );
    }
  }
}

async function syncOneSource(row: AlbumSourceRow): Promise<number> {
  const db = getDb();
  const adapter = buildAdapterForSource(row);
  if (!adapter || !adapter.isEnabled()) {
    return 0;
  }

  console.log(`[SYNC] Polling album source "${row.name}" (${row.type})...`);
  let ingested = 0;
  try {
    const photos = await adapter.pollNewPhotos();
    console.log(`[SYNC] Album source "${row.name}" returned ${photos.length} photos.`);

    for (const photo of photos) {
      const existing = db
        .prepare("SELECT id, album_source_id, downloaded_at FROM photos WHERE source = ? AND source_id = ?")
        .get(photo.source, photo.sourceId) as
        | { id: string; album_source_id: string | null; downloaded_at: number | null }
        | undefined;

      if (existing) {
        // Photos ingested before this source existed (e.g. via the old global-config-only
        // sync, or a source that was recreated) never got an album_source_id. Backfill it
        // now rather than leaving them permanently unassigned - otherwise a frame scoped to
        // this source would see zero matches forever, even though the source "successfully"
        // syncs on every run. Never overwrite a photo that's already tagged to some other
        // source, in case it's intentionally shared between sources.
        if (existing.album_source_id === null) {
          db.prepare("UPDATE photos SET album_source_id = ? WHERE id = ?").run(row.id, existing.id);
          console.log(`[SYNC] Backfilled album_source_id for existing photo ${existing.id} (source "${row.name}").`);
        }
        // A not-yet-downloaded photo's captured URL can go stale (Google OAuth/iCloud both
        // use time-limited links) before it's ever actually fetched. Refresh it on every sync
        // so ensurePhotoDownloaded always has a recent URL to try first.
        if (!existing.downloaded_at) {
          db.prepare("UPDATE photos SET original_url = ? WHERE id = ?").run(photo.originalUrl, existing.id);
        }
        continue; // already processed
      }

      console.log(`[SYNC] Registering new photo: ${photo.id} (${photo.source}, source "${row.name}")...`);
      await registerPhotoPreview(photo, row.id, adapter);
      ingested++;
    }
    db.prepare("UPDATE album_sources SET last_synced_at = ? WHERE id = ?").run(Date.now(), row.id);
  } catch (err) {
    console.error(`[SYNC] Error polling album source "${row.name}":`, err);
  }
  return ingested;
}

export async function syncAlbums(): Promise<void> {
  if (isSyncRunning) {
    console.log("[SYNC] Sync already in progress, skipping run.");
    return;
  }

  isSyncRunning = true;
  try {
    const db = getDb();
    const sources = db.prepare("SELECT * FROM album_sources WHERE enabled = 1").all() as unknown as AlbumSourceRow[];
    for (const row of sources) {
      await syncOneSource(row);
    }
  } finally {
    isSyncRunning = false;
  }
  await prewarmUpcomingPhotos();
}

// Syncs a single album source immediately (used right after it's created via the API, so a
// newly-added album pulls its photos in without waiting for the next 15-minute cron tick).
// Deliberately does not take the isSyncRunning lock - it's fine for this to run alongside a
// periodic sync since they operate on disjoint/idempotent work (existing-photo dedup already
// guards re-ingestion).
export async function syncAlbumSourceNow(sourceId: string): Promise<{ ingested: number } | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM album_sources WHERE id = ?").get(sourceId) as AlbumSourceRow | undefined;
  if (!row) {
    return null;
  }
  const ingested = await syncOneSource(row);
  await prewarmUpcomingPhotos();
  return { ingested };
}

// Eager, full ingest used only for manual uploads (POST /api/v1/admin/upload) - the bytes are
// already local (a browser upload), so there's nothing to defer: render and store immediately.
export async function ingestPhoto(
  photo: RemotePhoto | { id?: string; source: string; downloadBuffer: () => Promise<Buffer> },
  albumSourceId?: string
): Promise<string> {
  const db = getDb();
  const rawBuffer = await photo.downloadBuffer();

  const hash = crypto.createHash("sha256").update(rawBuffer).digest("hex").slice(0, 16);
  const photoId = photo.id || `upload_${hash}`;

  const { origPath, binPath, analysis } = await renderPhotoAssets(photoId, rawBuffer);

  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, orientation, uploaded_at, is_active, album_source_id, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    photoId,
    photo.source,
    "sourceId" in photo ? photo.sourceId : photoId,
    "originalUrl" in photo ? photo.originalUrl : "",
    origPath,
    binPath,
    analysis.width,
    analysis.height,
    analysis.orientation,
    now,
    albumSourceId ?? null,
    now
  );

  // Enqueue as high priority (10) for immediate next frame poll
  enqueuePhoto(photoId, 10);
  console.log(`[SYNC] Successfully ingested and queued photo ${photoId}`);

  return photoId;
}

// How long a cloud photo's full-resolution original/binary must have sat unused before it's
// eligible for eviction. Generous on purpose - this only needs to bound total storage over
// the long run, not aggressively minimize it.
const EVICTION_MIN_AGE_MS = 24 * 3600 * 1000;

/**
 * Reclaims disk space from cloud-sourced photos (never manual uploads - those have no
 * re-downloadable source, so evicting them would lose the photo for good) whose full
 * original/e-paper binaries are no longer needed: not currently displayed on any frame, not
 * up next for any frame, and downloaded more than EVICTION_MIN_AGE_MS ago. Only the heavy
 * original JPEG and rendered .bin files are deleted - the small admin-gallery preview thumb
 * is kept, and the photo's row reverts to the same "preview only, not downloaded" state
 * registerPhotoPreview leaves a freshly-discovered photo in, so it's transparently
 * re-downloaded via ensurePhotoDownloaded next time it's actually needed.
 */
export async function evictStaleCloudPhotos(): Promise<number> {
  const db = getDb();

  const frames = db.prepare("SELECT id, current_image_id FROM frames").all() as Array<{
    id: string;
    current_image_id: string | null;
  }>;
  const protectedIds = new Set<string>();
  for (const f of frames) {
    if (f.current_image_id) protectedIds.add(f.current_image_id);
    const next = peekNextPhoto(f.id);
    if (next) protectedIds.add(next.id);
  }

  const cutoff = Date.now() - EVICTION_MIN_AGE_MS;
  const candidates = db
    .prepare(`SELECT id FROM photos WHERE source != 'upload' AND downloaded_at IS NOT NULL AND downloaded_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  let evicted = 0;
  for (const { id: photoId } of candidates) {
    if (protectedIds.has(photoId)) continue;

    const origPath = path.join(config.cacheDir, `${photoId}_orig.jpg`);
    await fs.promises.rm(origPath, { force: true });

    // Every rendered binary for this photo - one per orientation/fit-mode combination it's
    // ever been served in, plus the legacy no-suffix alias.
    for (const entry of await fs.promises.readdir(config.cacheDir).catch(() => [] as string[])) {
      if (entry === `${photoId}.bin` || (entry.startsWith(`${photoId}_`) && entry.endsWith(".bin"))) {
        await fs.promises.rm(path.join(config.cacheDir, entry), { force: true });
      }
    }

    db.prepare(`
      UPDATE photos SET file_path = '', bin_path = '', width = 0, height = 0, orientation = 'unknown', downloaded_at = NULL
      WHERE id = ?
    `).run(photoId);
    evicted++;
  }

  if (evicted > 0) {
    console.log(`[EVICT] Reclaimed disk space from ${evicted} cloud photo(s) not currently needed.`);
  }
  return evicted;
}

export function startSyncScheduler(): void {
  // Sync immediately on startup (after 5 seconds)
  setTimeout(() => {
    syncAlbums().catch((err) => console.error("[SYNC] Startup sync error:", err));
  }, 5000);

  // Schedule periodic poll every 15 minutes
  cron.schedule("*/15 * * * *", () => {
    syncAlbums().catch((err) => console.error("[SYNC] Cron sync error:", err));
  });

  // Reclaim disk space from cloud photos that are no longer needed, once a day.
  cron.schedule("0 3 * * *", () => {
    evictStaleCloudPhotos().catch((err) => console.error("[EVICT] Cron eviction error:", err));
  });
}
