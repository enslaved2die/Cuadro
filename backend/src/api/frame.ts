import fs from "node:fs";
import path from "node:path";
import { Router, Request, Response } from "express";
import { requireFrameAuth } from "./middleware.js";
import { getNextPhoto, isFrameStorageModeEnabled, PhotoRecord } from "../services/queue.js";
import { evaluateFrameWatchdog, recordFrameActivity, recordNextExpectedRefresh, recordCurrentImage } from "../services/watchdog.js";
import { generatePureWhiteBuffer, generateTestColorBars, BUFFER_SIZE_BYTES, writeFrameBinary } from "../pipeline/packer.js";
import { processImageToFrameBuffer, flattenEpdConfig, ProcessOptions } from "../pipeline/processor.js";
import { ensurePhotoDownloaded } from "../services/sync-scheduler.js";
import { config } from "../config.js";
import { getDb } from "../db/database.js";

export const frameRouter = Router();

// Apply Bearer token authentication to all frame endpoints
frameRouter.use(requireFrameAuth);

/**
 * GET /api/v1/frame/next
 * Primary frame poll endpoint. Delivers the next raw 960,000-byte frame buffer.
 */
frameRouter.get("/next", async (req: Request, res: Response) => {
  const frameId = (req.headers["x-frame-id"] as string) || req.ip || "unknown-frame";
  const batteryVoltage = parseFloat(req.headers["x-battery-voltage"] as string) || undefined;
  const firmwareVersion = (req.headers["x-firmware-version"] as string) || undefined;

  recordFrameActivity(frameId, batteryVoltage, firmwareVersion, false);
  const watchdog = evaluateFrameWatchdog(frameId);

  // Per-frame overrides (nullable columns = inherit the global default). `frame_orientation`
  // / `fit_mode` / `epdoptimize_config` on the `frames` row, when set, take precedence over
  // the global `config` singleton for this specific frame.
  const db = getDb();
  const frameRow = db.prepare("SELECT frame_orientation, fit_mode, epdoptimize_config FROM frames WHERE id = ?").get(frameId) as
    | { frame_orientation?: string | null; fit_mode?: string | null; epdoptimize_config?: string | null }
    | undefined;
  const effectiveFitMode: "matting" | "cover" | "rotate" = (frameRow?.fit_mode as any) || config.fitMode;
  let frameEpdOverride: ProcessOptions = {};
  if (frameRow?.epdoptimize_config) {
    try {
      frameEpdOverride = flattenEpdConfig(JSON.parse(frameRow.epdoptimize_config));
    } catch {
      // Malformed stored override; fall back to the global epdoptimize config.
    }
  }

  // 1. Check if Storage / Vacation Mode is active for THIS frame (per-frame, not global -
  // a fleet of frames should not all go into storage mode together).
  if (isFrameStorageModeEnabled(frameId)) {
    console.log(`[FRAME] Frame ${frameId} requested next photo, but Storage Mode is ACTIVE.`);
    recordNextExpectedRefresh(frameId, null); // indefinite sleep until button press
    const whiteBuffer = generatePureWhiteBuffer();
    res.setHeader("X-Image-ID", "white_storage_mode");
    res.setHeader("X-Sleep-Seconds", "0"); // 0 = indefinite sleep until button press
    res.setHeader("X-Frame-Mode", "STORAGE");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", whiteBuffer.length);
    res.send(whiteBuffer);
    return;
  }

  // 2. Fetch next photo from priority queue / idle shuffle
  let photo = getNextPhoto(frameId);

  // Cloud-sourced photos are registered as lightweight metadata + a small preview at sync
  // time (see sync-scheduler.ts#registerPhotoPreview); the full original and e-paper binary
  // are normally pre-warmed in the background well before a frame's next expected refresh
  // (see prewarmUpcomingPhotos). This is the safety net for the rare case that didn't happen
  // in time (e.g. a manual force-refresh landing within seconds of a photo first appearing) -
  // download it live now, at the cost of this one poll taking a couple of extra seconds.
  if (photo && !photo.downloaded_at) {
    console.log(`[FRAME] ${photo.id} isn't downloaded yet - fetching it now before responding...`);
    await ensurePhotoDownloaded(photo.id);
    // Re-read the same row directly (NOT getNextPhoto again, which would re-run selection and
    // double-count shown_count/queue-consumption) to pick up the now-populated file/bin paths.
    const refreshed = db.prepare("SELECT * FROM photos WHERE id = ?").get(photo.id) as PhotoRecord | undefined;
    if (refreshed) photo = refreshed;
  }

  if (photo) {
    const rawReqOrient = req.headers["x-frame-orientation"] as string;
    const requestedOrientation: "portrait" | "portrait_180" | "landscape" | "landscape_270" =
      rawReqOrient === "landscape" || rawReqOrient === "landscape_270" || rawReqOrient === "portrait" || rawReqOrient === "portrait_180"
        ? rawReqOrient as any
        : (frameRow?.frame_orientation as any) || config.frameOrientation;

    const targetBinPath = path.join(
      config.cacheDir,
      `${photo.id}_${requestedOrientation}_${effectiveFitMode}.bin`
    );

    let activeBinPath = targetBinPath;
    if (!fs.existsSync(activeBinPath)) {
      if (fs.existsSync(photo.bin_path)) {
        activeBinPath = photo.bin_path;
      }
    }

    // If matching binary is missing, dynamically render from original photo
    if (!fs.existsSync(activeBinPath) && fs.existsSync(photo.file_path)) {
      console.log(
        `[FRAME] Dynamically rendering ${photo.id} for ${requestedOrientation} (${effectiveFitMode})...`
      );
      try {
        const raw = await fs.promises.readFile(photo.file_path);
        const buf = await processImageToFrameBuffer(raw, {
          frameOrientation: requestedOrientation,
          fitMode: effectiveFitMode,
          ...frameEpdOverride
        });
        await writeFrameBinary(targetBinPath, buf);
        activeBinPath = targetBinPath;
      } catch (err) {
        console.error(`[FRAME] Dynamic render failed for ${photo.id}:`, err);
      }
    }

    if (fs.existsSync(activeBinPath)) {
      console.log(`[FRAME] Serving photo ${photo.id} (${requestedOrientation}) to frame ${frameId}.`);
      recordNextExpectedRefresh(frameId, watchdog.recommendedSleepSeconds);
      res.setHeader("X-Image-ID", photo.id);
      res.setHeader("X-Sleep-Seconds", watchdog.recommendedSleepSeconds.toString());
      res.setHeader("X-Frame-Mode", watchdog.shouldForceRefresh ? "FORCE_CYCLE" : "NORMAL");
      res.setHeader("X-Frame-Orientation", requestedOrientation);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", BUFFER_SIZE_BYTES);

      const stream = fs.createReadStream(activeBinPath);
      stream.pipe(res);
      return;
    }
  }

  // 3. Fallback: If no photos uploaded yet, serve the calibrated test color bars
  console.log(`[FRAME] No photos available in library; serving bring-up color bar test pattern.`);
  recordNextExpectedRefresh(frameId, watchdog.recommendedSleepSeconds);
  const testPattern = generateTestColorBars();
  res.setHeader("X-Image-ID", "test_pattern_colorbars");
  res.setHeader("X-Sleep-Seconds", watchdog.recommendedSleepSeconds.toString());
  res.setHeader("X-Frame-Mode", "TEST_PATTERN");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", testPattern.length);
  res.send(testPattern);
});

/**
 * POST /api/v1/frame/ack
 * Frame telemetry and refresh acknowledgment.
 */
frameRouter.post("/ack", (req: Request, res: Response) => {
  const frameId = (req.headers["x-frame-id"] as string) || req.ip || "unknown-frame";
  const { imageId, status, drawDurationMs, rssi, batteryVoltage } = req.body || {};

  console.log(
    `[FRAME ACK] Frame: ${frameId}, Image: ${imageId}, Status: ${status}, Duration: ${drawDurationMs}ms, RSSI: ${rssi}dBm, Battery: ${batteryVoltage}V`
  );

  const isSuccess = status === "SUCCESS";
  recordFrameActivity(frameId, batteryVoltage, undefined, isSuccess);
  if (isSuccess && typeof imageId === "string" && imageId) {
    recordCurrentImage(frameId, imageId);
  }

  const watchdog = evaluateFrameWatchdog(frameId);
  res.json({
    status: "OK",
    nextSleepSeconds: watchdog.recommendedSleepSeconds
  });
});

/**
 * GET /api/v1/frame/white
 * Directly returns the pre-baked pure white buffer for manual storage clear.
 */
frameRouter.get("/white", (req: Request, res: Response) => {
  const whiteBuffer = generatePureWhiteBuffer();
  res.setHeader("X-Image-ID", "white_storage_mode");
  res.setHeader("X-Sleep-Seconds", "0");
  res.setHeader("X-Frame-Mode", "STORAGE");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", whiteBuffer.length);
  res.send(whiteBuffer);
});
