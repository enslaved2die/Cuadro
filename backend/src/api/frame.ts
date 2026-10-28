import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { requireFrameAuth } from "./middleware.js";
import { getNextPhoto, isFrameStorageModeEnabled, PhotoRecord } from "../services/queue.js";
import { evaluateFrameWatchdog, recordFrameActivity, recordNextExpectedRefresh, recordCurrentImage, recordOtaStatus } from "../services/watchdog.js";
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
  const frameRow = db.prepare("SELECT frame_orientation, fit_mode, epdoptimize_config, target_firmware_version, ota_status FROM frames WHERE id = ?").get(frameId) as
    | { frame_orientation?: string | null; fit_mode?: string | null; epdoptimize_config?: string | null; target_firmware_version?: string | null; ota_status?: string | null }
    | undefined;

  const rawReqFitMode = req.headers["x-fit-mode"] as string | undefined;
  let effectiveFitMode: "matting" | "cover" | "rotate" =
    rawReqFitMode === "matting" || rawReqFitMode === "cover" || rawReqFitMode === "rotate"
      ? rawReqFitMode
      : (frameRow?.fit_mode as any) || config.fitMode;

  // If the built-in Hardware Emulator has no explicit fit_mode override of its own, and the
  // user configured a custom fit_mode on their physical frame in the Frames tab, mirror it so
  // the Emulator preview matches their physical frame.
  if (frameId === "EMULATOR-709E" && !rawReqFitMode && !frameRow?.fit_mode) {
    const physicalOverrides = db
      .prepare("SELECT DISTINCT fit_mode FROM frames WHERE id != 'EMULATOR-709E' AND fit_mode IS NOT NULL")
      .all() as Array<{ fit_mode: string }>;
    if (physicalOverrides.length === 1) {
      const m = physicalOverrides[0].fit_mode;
      if (m === "matting" || m === "cover" || m === "rotate") {
        effectiveFitMode = m;
      }
    }
  }
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

  // 1b. Check for OTA firmware update eligibility (frame-specific target or fleet-wide active release).
  // Runs BEFORE getNextPhoto(frameId) so an express OTA update does not consume a queue item or
  // trigger a redundant 960KB photo download + 18s e-paper refresh right before rebooting.
  let targetRelease: { version: string; file_path: string; sha256: string; size_bytes: number } | undefined;
  if (frameRow?.target_firmware_version) {
    targetRelease = db.prepare("SELECT version, file_path, sha256, size_bytes FROM firmware_releases WHERE version = ?").get(frameRow.target_firmware_version) as any;
  }
  if (!targetRelease) {
    targetRelease = db.prepare("SELECT version, file_path, sha256, size_bytes FROM firmware_releases WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1").get() as any;
  }

  if (targetRelease && firmwareVersion) {
    if (firmwareVersion === targetRelease.version) {
      // Frame is already running the target version; mark OTA status as success if it was pending/updating/flashed.
      if (frameRow?.ota_status && frameRow.ota_status !== "success" && frameRow.ota_status !== "idle") {
        recordOtaStatus(frameId, targetRelease.version, "success");
      }
    } else if (fs.existsSync(targetRelease.file_path)) {
      if (frameRow?.ota_status === "flashed") {
        // The frame already flashed targetRelease.version and rebooted on the previous cycle,
        // yet it just checked in still reporting firmwareVersion != targetRelease.version!
        // Either the ESP32 bootloader rolled back to the previous slot, or the uploaded .bin
        // had a different FIRMWARE_VERSION compiled in. Mark as failed to prevent an infinite flash loop.
        const msg = `Rollback or version mismatch: device reported v${firmwareVersion} after flashing v${targetRelease.version}`;
        console.warn(`[OTA] Frame ${frameId}: ${msg}`);
        recordOtaStatus(frameId, targetRelease.version, "failed", msg);
      } else if (frameRow?.ota_status !== "failed") {
        console.log(`[OTA] Dispatching OTA update v${targetRelease.version} to frame ${frameId} (currently v${firmwareVersion}).`);
        recordNextExpectedRefresh(frameId, watchdog.recommendedSleepSeconds);
        res.setHeader("X-Frame-Mode", "OTA_UPDATE");
        res.setHeader("X-Sleep-Seconds", watchdog.recommendedSleepSeconds.toString());
        res.setHeader("X-OTA-Available", "1");
        res.setHeader("X-OTA-Version", targetRelease.version);
        res.setHeader("X-OTA-Url", `/api/v1/frame/ota/bin?version=${encodeURIComponent(targetRelease.version)}`);
        res.setHeader("X-OTA-SHA256", targetRelease.sha256);
        res.setHeader("X-OTA-Size", targetRelease.size_bytes.toString());
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", "0");
        res.status(200).end();
        return;
      }
    }
  }

  // 2. Fetch next photo from priority queue / idle shuffle
  let photo = getNextPhoto(frameId);

  // Cloud-sourced photos are registered as lightweight metadata + a small preview at sync
  // time (see sync-scheduler.ts#registerPhotoPreview); the full original and e-paper binary
  // are normally pre-warmed in the background well before a frame's next expected refresh
  // (see prewarmUpcomingPhotos). This is the safety net for the rare case that didn't happen
  // in time (e.g. a manual force-refresh landing within seconds of a photo first appearing) -
  // download it live now, at the cost of this one poll taking a couple of extra seconds.
  if (photo && (!photo.downloaded_at || !photo.file_path || !fs.existsSync(photo.file_path))) {
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

    const epdSuffix = frameRow?.epdoptimize_config
      ? `_${crypto.createHash("sha256").update(frameRow.epdoptimize_config).digest("hex").slice(0, 8)}`
      : "";
    const targetBinPath = path.join(
      config.cacheDir,
      `${photo.id}_${requestedOrientation}_${effectiveFitMode}${epdSuffix}.bin`
    );

    let activeBinPath = targetBinPath;

    // If matching binary for this orientation/fitMode/epdConfig is missing, dynamically render from original photo
    if (!fs.existsSync(activeBinPath) && photo.file_path && fs.existsSync(photo.file_path)) {
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

    // Fall back to default pre-rendered binary only if targetBinPath still doesn't exist
    if (!fs.existsSync(activeBinPath) && photo.bin_path && fs.existsSync(photo.bin_path)) {
      activeBinPath = photo.bin_path;
    }

    if (fs.existsSync(activeBinPath)) {
      console.log(`[FRAME] Serving photo ${photo.id} (${requestedOrientation}, fit=${effectiveFitMode}) to frame ${frameId}.`);
      recordNextExpectedRefresh(frameId, watchdog.recommendedSleepSeconds);
      res.setHeader("X-Image-ID", photo.id);
      res.setHeader("X-Sleep-Seconds", watchdog.recommendedSleepSeconds.toString());
      res.setHeader("X-Frame-Mode", watchdog.shouldForceRefresh ? "FORCE_CYCLE" : "NORMAL");
      res.setHeader("X-Frame-Orientation", requestedOrientation);
      res.setHeader("X-Fit-Mode", effectiveFitMode);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", BUFFER_SIZE_BYTES);

      const stream = fs.createReadStream(activeBinPath);
      stream.on("error", (err) => {
        console.error(`[FRAME] Error streaming binary ${activeBinPath}:`, err);
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy();
        }
      });
      res.on("close", () => stream.destroy());
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

/**
 * GET /api/v1/frame/ota/bin
 * Streams the requested (or currently active) firmware binary to the frame.
 */
frameRouter.get("/ota/bin", (req: Request, res: Response) => {
  const version = typeof req.query.version === "string" ? req.query.version : undefined;
  const db = getDb();
  let release: { version: string; file_path: string; sha256: string; size_bytes: number } | undefined;

  if (version) {
    release = db.prepare("SELECT version, file_path, sha256, size_bytes FROM firmware_releases WHERE version = ?").get(version) as any;
  } else {
    release = db.prepare("SELECT version, file_path, sha256, size_bytes FROM firmware_releases WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1").get() as any;
  }

  if (!release || !fs.existsSync(release.file_path)) {
    res.status(404).json({ error: "Firmware binary not found on server." });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", release.size_bytes.toString());
  res.setHeader("X-Firmware-SHA256", release.sha256);
  res.setHeader("X-Firmware-Version", release.version);

  const stream = fs.createReadStream(release.file_path);
  stream.on("error", (err) => {
    console.error(`[OTA] Error streaming firmware binary ${release?.file_path}:`, err);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
});

/**
 * POST /api/v1/frame/ota/status
 * Telemetry endpoint for the frame to report download, flash, and boot progress/results.
 */
frameRouter.post("/ota/status", (req: Request, res: Response) => {
  const frameId = (req.headers["x-frame-id"] as string) || req.ip || "unknown-frame";
  const { version, status, error } = req.body || {};

  if (!version || !status) {
    res.status(400).json({ error: "version and status are required fields." });
    return;
  }

  recordOtaStatus(frameId, String(version), String(status), error ? String(error) : undefined);
  console.log(`[OTA-TELEMETRY] Frame ${frameId} reported: ${status} (v${version})${error ? ` - Error: ${error}` : ""}`);

  res.json({ status: "success" });
});
