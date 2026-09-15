import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Router, Request, Response } from "express";
import { requireAdminAuth } from "./middleware.js";
import { getDb } from "../db/database.js";
import { enqueuePhoto, peekNextPhoto } from "../services/queue.js";
import { syncAlbums, ingestPhoto } from "../services/sync-scheduler.js";
import { config, reloadConfigFromDb, DEFAULT_EPDOPTIMIZE_CONFIG } from "../config.js";
import { secondsUntilNextScheduledTime } from "../services/schedule.js";
import { GooglePhotosAdapter } from "../adapters/google-photos.js";
import { ImmichAdapter } from "../adapters/immich.js";
import { ICloudAdapter } from "../adapters/icloud.js";
import { getImageAnalysis, processImageToFrameBuffer } from "../pipeline/processor.js";
import { writeFrameBinary } from "../pipeline/packer.js";
import { validateEpdoptimizeConfig, validateRefreshSchedule, isValidFrameOrientation, isValidFitMode } from "./validators.js";

export const adminRouter = Router();

adminRouter.use(requireAdminAuth);

// How recently a frame must have checked in to be considered "active" (mid check-in cycle).
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

// Slack added on top of `next_expected_refresh_at` before a frame is flagged as running
// late. Frame logs show boot + Wi-Fi connect + fetch can take anywhere from ~5s to 50+s;
// this also absorbs a bit of clock drift between the server and the frame's RTC.
const REFRESH_GRACE_MS = 5 * 60 * 1000;

/**
 * Determines a frame's displayed status.
 *
 * Historically this compared `elapsed` (time since last check-in) against a window derived
 * from the single global `config.defaultSleepSeconds`. That broke once per-frame Scheduled
 * Refresh times were introduced (backend/src/services/schedule.ts): a frame waiting many
 * hours for e.g. an 18:00 refresh would sail past `defaultSleepSeconds + 1800s` and get
 * mislabeled "offline" even though it was exactly where it should be.
 *
 * `frames.next_expected_refresh_at` (populated on every check-in via
 * watchdog.ts#recordNextExpectedRefresh) is the authoritative answer to "when should this
 * frame check in next" - it already reflects whichever schedule or interval applies to that
 * specific frame - so we prefer it whenever it's available, and only fall back to the old
 * global-interval heuristic for frames that haven't recorded one yet (e.g. brand new frames).
 */
export function computeFrameState(f: any, now: number, elapsed: number): "active" | "sleeping" | "overdue" | "offline" {
  if (elapsed < ACTIVE_WINDOW_MS) {
    return "active";
  }

  const nextExpected: number | null = f.next_expected_refresh_at || null;

  if (nextExpected == null) {
    // No recorded expectation (new frame, or storage mode's indefinite sleep) - fall back to
    // the old global-interval based window.
    if (elapsed < (config.defaultSleepSeconds + 1800) * 1000) {
      return "sleeping";
    }
    return "offline";
  }

  // Length of the frame's current sleep cycle, used to size the "overdue" window below.
  // Falls back to the global default interval if we can't derive it from this check-in.
  const cycleMs = f.last_checkin_at && nextExpected > f.last_checkin_at
    ? nextExpected - f.last_checkin_at
    : config.defaultSleepSeconds * 1000;

  if (now < nextExpected + REFRESH_GRACE_MS) {
    // Right where it should be, mid-sleep, waiting for its next scheduled/interval wake.
    return "sleeping";
  }

  if (now < nextExpected + REFRESH_GRACE_MS + cycleMs) {
    // Should have checked in by now but hasn't - within one extra cycle's worth of time.
    // Worth flagging distinctly: this could just be a slow Wi-Fi retry or captive-portal
    // session rather than a genuinely dead frame.
    return "overdue";
  }

  // Missed multiple full cycles with no activity at all - genuinely offline.
  return "offline";
}

/**
 * GET /api/v1/admin/status
 */
adminRouter.get("/status", (req: Request, res: Response) => {
  const db = getDb();
  const rawFrames = db.prepare("SELECT * FROM frames ORDER BY last_checkin_at DESC").all() as any[];
  const photoCount = (db.prepare("SELECT COUNT(*) as count FROM photos WHERE is_active = 1").get() as { count: number }).count;
  const queuedCount = (db.prepare("SELECT COUNT(*) as count FROM queue WHERE status = 'pending'").get() as { count: number }).count;

  // Fetch every frame's assigned album sources in one query (rather than one query per
  // frame) so this endpoint stays free of N+1 lookups as the number of frames grows.
  const assignmentRows = db
    .prepare(
      `SELECT faa.frame_id as frameId, s.id as id, s.name as name, s.type as type
       FROM frame_album_assignments faa
       JOIN album_sources s ON s.id = faa.album_source_id`
    )
    .all() as Array<{ frameId: string; id: string; name: string; type: string }>;
  const assignmentsByFrame = new Map<string, Array<{ id: string; name: string; type: string }>>();
  for (const row of assignmentRows) {
    const list = assignmentsByFrame.get(row.frameId) || [];
    list.push({ id: row.id, name: row.name, type: row.type });
    assignmentsByFrame.set(row.frameId, list);
  }

  const now = Date.now();
  const frames = rawFrames.map((f) => {
    const elapsed = now - (f.last_checkin_at || 0);
    const state = computeFrameState(f, now, elapsed);
    const albumSources = assignmentsByFrame.get(f.id) || [];

    let epdoptimizeConfig: unknown = null;
    if (f.epdoptimize_config) {
      try {
        epdoptimizeConfig = JSON.parse(f.epdoptimize_config);
      } catch {
        epdoptimizeConfig = null;
      }
    }
    let refreshSchedule: unknown = null;
    if (f.refresh_schedule) {
      try {
        refreshSchedule = JSON.parse(f.refresh_schedule);
      } catch {
        refreshSchedule = null;
      }
    }

    return {
      ...f,
      state,
      elapsedSeconds: Math.round(elapsed / 1000),
      // Per-frame overrides, parsed (null means "inherit global default").
      frameOrientation: f.frame_orientation || null,
      fitMode: f.fit_mode || null,
      epdoptimizeConfig,
      refreshSchedule,
      storageMode: Boolean(f.storage_mode),
      // Assigned album sources (empty array means "no explicit assignment" -> whole-library
      // fallback per Phase 1 semantics in queue.ts#getNextPhoto).
      albumSourceIds: albumSources.map((s) => s.id),
      albumSources,
      // Read-only preview of what the frame would be served on its next poll - does not
      // consume the queue or affect real serving order (see queue.ts#peekNextPhoto).
      nextPhotoId: peekNextPhoto(f.id)?.id ?? null
    };
  });

  res.json({
    status: "healthy",
    stats: {
      photoCount,
      queuedCount,
      activeFrames: frames.filter(f => f.state !== "offline").length
    },
    frames,
    refreshSchedule: config.refreshSchedule.enabled
      ? {
          ...config.refreshSchedule,
          nextRefreshAt: now + secondsUntilNextScheduledTime(config.refreshSchedule.times, config.refreshSchedule.timezone) * 1000
        }
      : config.refreshSchedule
  });
});

/**
 * DELETE /api/v1/admin/frames/:frameId
 */
adminRouter.delete("/frames/:frameId", (req: Request, res: Response) => {
  const frameId = String(req.params.frameId);
  const db = getDb();
  db.prepare("DELETE FROM frames WHERE id = ?").run(frameId);
  res.json({ status: "success", message: `Frame ${frameId} removed.` });
});

/**
 * POST /api/v1/admin/sync
 */
adminRouter.post("/sync", async (req: Request, res: Response) => {
  try {
    // Run sync in background and return immediate response
    syncAlbums().catch((err) => console.error("[ADMIN SYNC ERROR]", err));
    res.json({ message: "Album sync initiated." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/upload
 * Direct binary/form upload of an image.
 */
adminRouter.post("/upload", async (req: Request, res: Response) => {
  try {
    const rawChunks: Buffer[] = [];
    req.on("data", (chunk) => rawChunks.push(chunk));
    await new Promise((resolve) => req.on("end", resolve));
    const imageBuffer = Buffer.concat(rawChunks);

    if (imageBuffer.length === 0) {
      res.status(400).json({ error: "Empty upload payload" });
      return;
    }

    const albumSourceId = typeof req.query.albumSourceId === "string" && req.query.albumSourceId.length > 0
      ? req.query.albumSourceId
      : undefined;

    const photoId = await ingestPhoto({
      source: "upload",
      downloadBuffer: async () => imageBuffer
    }, albumSourceId);

    res.json({ status: "success", photoId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/admin/photos
 */
adminRouter.get("/photos", (req: Request, res: Response) => {
  const db = getDb();
  const photos = db.prepare("SELECT * FROM photos WHERE is_active = 1 ORDER BY uploaded_at DESC LIMIT 100").all() as any[];
  const enhanced = photos.map(p => ({
    ...p,
    hasThumb: fs.existsSync(path.join(config.cacheDir, `${p.id}_thumb.jpg`))
  }));
  res.json(enhanced);
});

/**
 * GET /api/v1/admin/photos/:photoId/thumb
 */
adminRouter.get("/photos/:photoId/thumb", (req: Request, res: Response) => {
  const photoId = String(req.params.photoId);
  const thumbPath = path.join(config.cacheDir, `${photoId}_thumb.jpg`);
  const origPath = path.join(config.cacheDir, `${photoId}_orig.jpg`);

  if (fs.existsSync(thumbPath)) {
    res.setHeader("Content-Type", "image/jpeg");
    fs.createReadStream(thumbPath).pipe(res);
    return;
  }

  if (fs.existsSync(origPath)) {
    res.setHeader("Content-Type", "image/jpeg");
    fs.createReadStream(origPath).pipe(res);
    return;
  }

  res.status(404).send("Thumbnail not found");
});

/**
 * PATCH /api/v1/admin/photos/:photoId
 * Reassigns a photo's album source (e.g. moving an upload into a "Manual" bucket, or
 * unassigning it back to null / whole-library). Body: { albumSourceId: string | null }.
 */
adminRouter.patch("/photos/:photoId", (req: Request, res: Response) => {
  const photoId = String(req.params.photoId);
  const { albumSourceId } = req.body || {};

  if (albumSourceId !== null && typeof albumSourceId !== "string") {
    res.status(400).json({ status: "error", error: "albumSourceId must be a string or null." });
    return;
  }

  const db = getDb();
  const photo = db.prepare("SELECT id FROM photos WHERE id = ?").get(photoId);
  if (!photo) {
    res.status(404).json({ status: "error", error: "Photo not found." });
    return;
  }

  if (albumSourceId !== null) {
    const source = db.prepare("SELECT id FROM album_sources WHERE id = ?").get(albumSourceId);
    if (!source) {
      res.status(400).json({ status: "error", error: "Unknown album source id." });
      return;
    }
  }

  db.prepare("UPDATE photos SET album_source_id = ? WHERE id = ?").run(albumSourceId, photoId);
  res.json({ status: "success" });
});

/**
 * DELETE /api/v1/admin/photos/:photoId
 */
adminRouter.delete("/photos/:photoId", (req: Request, res: Response) => {
  const photoId = String(req.params.photoId);
  const db = getDb();
  db.prepare("UPDATE photos SET is_active = 0 WHERE id = ?").run(photoId);
  db.prepare("DELETE FROM queue WHERE photo_id = ?").run(photoId);
  res.json({ status: "success", message: `Photo ${photoId} deleted.` });
});

/**
 * POST /api/v1/admin/queue/:photoId
 */
adminRouter.post("/queue/:photoId", (req: Request, res: Response) => {
  const photoId = String(req.params.photoId);
  enqueuePhoto(photoId, 15);
  res.json({ message: `Photo ${photoId} queued with high priority.` });
});

/**
 * POST /api/v1/admin/reprocess
 * Reprocesses all active photos in the library with current frame orientation and fit mode.
 */
adminRouter.post("/reprocess", async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const photos = db.prepare("SELECT * FROM photos WHERE is_active = 1").all() as any[];
    console.log(`[ADMIN REPROCESS] Reprocessing ${photos.length} photos with ${config.frameOrientation} (${config.fitMode})...`);

    let count = 0;
    for (const photo of photos) {
      if (!fs.existsSync(photo.file_path)) continue;
      try {
        const raw = await fs.promises.readFile(photo.file_path);
        const analysis = await getImageAnalysis(raw);

        // Generate thumbnail
        const thumbPath = path.join(config.cacheDir, `${photo.id}_thumb.jpg`);
        await sharp(raw).rotate().resize(320, 320, { fit: "inside" }).jpeg({ quality: 80 }).toFile(thumbPath).catch(() => {});

        // Render binary
        const binBuf = await processImageToFrameBuffer(raw, {
          frameOrientation: config.frameOrientation,
          fitMode: config.fitMode
        });
        const targetBin = path.join(config.cacheDir, `${photo.id}_${config.frameOrientation}_${config.fitMode}.bin`);
        await writeFrameBinary(targetBin, binBuf);
        await writeFrameBinary(path.join(config.cacheDir, `${photo.id}.bin`), binBuf);

        // Update database with true dimensions and orientation
        db.prepare("UPDATE photos SET width = ?, height = ?, orientation = ? WHERE id = ?").run(
          analysis.width,
          analysis.height,
          analysis.orientation,
          photo.id
        );
        count++;
      } catch (err) {
        console.error(`[ADMIN REPROCESS ERROR] Failed on ${photo.id}:`, err);
      }
    }

    res.json({ status: "success", count, message: `Successfully reprocessed ${count} photos.` });
  } catch (err: any) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/admin/settings
 */
adminRouter.get("/settings", (req: Request, res: Response) => {
  res.json({
    frameToken: config.frameToken,
    frameOrientation: config.frameOrientation,
    fitMode: config.fitMode,
    epdoptimizeConfig: config.epdoptimizeConfig,
    epdoptimizeConfigDefault: DEFAULT_EPDOPTIMIZE_CONFIG,
    refreshSchedule: config.refreshSchedule,
    defaultSleepSeconds: config.defaultSleepSeconds,
    googlePhotos: {
      shareUrl: config.googlePhotosShareUrl,
      clientId: config.googlePhotosClientId,
      clientSecret: config.googlePhotosClientSecret ? "••••••••" : "",
      refreshToken: config.googlePhotosRefreshToken ? "••••••••" : "",
      albumId: config.googlePhotosAlbumId,
      enabled: Boolean(
        config.googlePhotosShareUrl ||
        (config.googlePhotosClientId &&
         config.googlePhotosClientSecret &&
         config.googlePhotosRefreshToken &&
         config.googlePhotosAlbumId)
      )
    },
    immich: {
      host: config.immichHost,
      apiKey: config.immichApiKey ? "••••••••" : "",
      albumId: config.immichAlbumId,
      enabled: Boolean(config.immichHost && config.immichApiKey && config.immichAlbumId)
    },
    icloud: {
      token: config.icloudSharedAlbumToken,
      enabled: Boolean(config.icloudSharedAlbumToken)
    }
  });
});

/**
 * POST /api/v1/admin/settings
 */
adminRouter.post("/settings", (req: Request, res: Response) => {
  const db = getDb();
  const upsertSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

  const { frameOrientation, fitMode, epdoptimizeConfig, refreshSchedule, googlePhotos, immich, icloud } = req.body || {};

  if (isValidFrameOrientation(frameOrientation)) {
    upsertSetting.run("frame_orientation", frameOrientation);
  }

  if (isValidFitMode(fitMode)) {
    upsertSetting.run("fit_mode", fitMode);
  }

  if (epdoptimizeConfig !== undefined) {
    const { value, error } = validateEpdoptimizeConfig(epdoptimizeConfig);
    if (error) {
      res.status(400).json({ status: "error", error });
      return;
    }
    upsertSetting.run("epdoptimize_config", JSON.stringify(value));
  }

  if (refreshSchedule !== undefined) {
    const { value, error } = validateRefreshSchedule(refreshSchedule);
    if (error) {
      res.status(400).json({ status: "error", error });
      return;
    }
    upsertSetting.run("refresh_schedule", JSON.stringify(value));
  }

  if (googlePhotos) {
    if (googlePhotos.shareUrl !== undefined) upsertSetting.run("google_photos_share_url", String(googlePhotos.shareUrl).trim());
    if (googlePhotos.clientId !== undefined) upsertSetting.run("google_photos_client_id", String(googlePhotos.clientId).trim());
    if (googlePhotos.clientSecret && googlePhotos.clientSecret !== "••••••••") {
      upsertSetting.run("google_photos_client_secret", String(googlePhotos.clientSecret).trim());
    }
    if (googlePhotos.refreshToken && googlePhotos.refreshToken !== "••••••••") {
      upsertSetting.run("google_photos_refresh_token", String(googlePhotos.refreshToken).trim());
    }
    if (googlePhotos.albumId !== undefined) upsertSetting.run("google_photos_album_id", String(googlePhotos.albumId).trim());
  }

  if (immich) {
    if (immich.host !== undefined) upsertSetting.run("immich_host", String(immich.host).trim());
    if (immich.apiKey && immich.apiKey !== "••••••••") {
      upsertSetting.run("immich_api_key", String(immich.apiKey).trim());
    }
    if (immich.albumId !== undefined) upsertSetting.run("immich_album_id", String(immich.albumId).trim());
  }

  if (icloud) {
    if (icloud.token !== undefined) upsertSetting.run("icloud_shared_album_token", String(icloud.token).trim());
  }

  reloadConfigFromDb(db);
  res.json({
    status: "success",
    message: "Settings saved successfully.",
    frameOrientation: config.frameOrientation,
    fitMode: config.fitMode,
    epdoptimizeConfig: config.epdoptimizeConfig,
    refreshSchedule: config.refreshSchedule
  });
});

/**
 * POST /api/v1/admin/test-album
 */
adminRouter.post("/test-album", async (req: Request, res: Response) => {
  const { source } = req.body || {};
  try {
    if (source === "google_photos") {
      const adapter = new GooglePhotosAdapter();
      if (!adapter.isEnabled()) {
        res.status(400).json({ success: false, error: "Google Photos credentials are incomplete. Please fill Client ID, Secret, Refresh Token, and Album ID." });
        return;
      }
      const photos = await adapter.pollNewPhotos();
      res.json({ success: true, count: photos.length });
    } else if (source === "immich") {
      const adapter = new ImmichAdapter();
      if (!adapter.isEnabled()) {
        res.status(400).json({ success: false, error: "Immich configuration is incomplete. Please fill Host, API Key, and Album UUID." });
        return;
      }
      const photos = await adapter.pollNewPhotos();
      res.json({ success: true, count: photos.length });
    } else if (source === "icloud") {
      const adapter = new ICloudAdapter();
      if (!adapter.isEnabled()) {
        res.status(400).json({ success: false, error: "iCloud token is missing." });
        return;
      }
      const photos = await adapter.pollNewPhotos();
      res.json({ success: true, count: photos.length });
    } else {
      res.status(400).json({ success: false, error: "Unknown source" });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
