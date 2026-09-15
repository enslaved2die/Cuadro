import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { requireAdminAuth } from "./middleware.js";
import { getDb } from "../db/database.js";
import { GooglePhotosSourceConfig } from "../adapters/google-photos.js";
import { ImmichSourceConfig } from "../adapters/immich.js";
import { ICloudSourceConfig } from "../adapters/icloud.js";
import { syncAlbumSourceNow } from "../services/sync-scheduler.js";
import {
  SECRET_MASK,
  maskSecret,
  isValidFrameOrientation,
  isValidFitMode,
  validateEpdoptimizeConfig,
  validateRefreshSchedule
} from "./validators.js";

export const albumSourcesRouter = Router();

albumSourcesRouter.use(requireAdminAuth);

/**
 * Phase 2+3 of the multi-frame architecture: REST API for managing `album_sources` rows
 * and per-frame settings (assigned sources + override columns), built on top of the
 * Phase 1 schema/migration in db/database.ts. See that file's `migrateAlbumSourcesV2` and
 * services/queue.ts's `getNextPhoto` for the data model and fallback semantics this API
 * has to respect.
 */

export const ALBUM_SOURCE_TYPES = ["google_photos", "immich", "icloud", "manual"] as const;
export type AlbumSourceType = (typeof ALBUM_SOURCE_TYPES)[number];

function isValidAlbumSourceType(value: unknown): value is AlbumSourceType {
  return typeof value === "string" && (ALBUM_SOURCE_TYPES as readonly string[]).includes(value);
}

// Which config_json fields are secrets that should be masked on read and never overwritten
// by an unchanged masked sentinel on update - mirrors the pattern already used for the
// global Google/Immich/iCloud settings in admin.ts's GET/POST /settings.
const SECRET_FIELDS_BY_TYPE: Record<AlbumSourceType, string[]> = {
  google_photos: ["clientSecret", "refreshToken"],
  immich: ["apiKey"],
  icloud: ["token"],
  manual: []
};

// All fields accepted in config_json per type (anything else in the request body is dropped).
const ALLOWED_FIELDS_BY_TYPE: Record<AlbumSourceType, string[]> = {
  google_photos: ["shareUrl", "clientId", "clientSecret", "refreshToken", "albumId"],
  immich: ["host", "apiKey", "albumId"],
  icloud: ["token"],
  manual: []
};

type AlbumSourceConfig = GooglePhotosSourceConfig | ImmichSourceConfig | ICloudSourceConfig;

interface AlbumSourceRow {
  id: string;
  name: string;
  type: AlbumSourceType;
  config_json: string;
  enabled: number;
  last_synced_at: number | null;
  created_at: number;
}

function maskConfig(type: AlbumSourceType, config: Record<string, any>): Record<string, any> {
  const secretFields = SECRET_FIELDS_BY_TYPE[type] || [];
  const masked: Record<string, any> = { ...config };
  for (const field of secretFields) {
    masked[field] = maskSecret(config[field]);
  }
  return masked;
}

function serializeSource(row: AlbumSourceRow) {
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config_json) || {};
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: maskConfig(row.type, config),
    enabled: Boolean(row.enabled),
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at
  };
}

/**
 * Validates that a freshly-created source's config is actually capable of authenticating,
 * mirroring each adapter's own `isEnabled()` logic (see adapters/google-photos.ts,
 * immich.ts, icloud.ts). Returns an error string, or undefined if valid.
 */
function validateRequiredConfig(type: AlbumSourceType, config: Record<string, any>): string | undefined {
  if (type === "google_photos") {
    const hasShareUrl = Boolean(config.shareUrl);
    const hasOAuth = Boolean(config.clientId && config.clientSecret && config.refreshToken && config.albumId);
    if (!hasShareUrl && !hasOAuth) {
      return "google_photos config requires either shareUrl, or clientId + clientSecret + refreshToken + albumId.";
    }
  } else if (type === "immich") {
    if (!(config.host && config.apiKey && config.albumId)) {
      return "immich config requires host, apiKey, and albumId.";
    }
  } else if (type === "icloud") {
    if (!config.token) {
      return "icloud config requires token.";
    }
  }
  // "manual" requires no config - it's just a named bucket that photos get uploaded/assigned
  // into directly (see POST /api/v1/admin/upload's albumSourceId param and PATCH
  // /api/v1/admin/photos/:photoId), never polled by the sync scheduler.
  return undefined;
}

function sanitizeConfigInput(type: AlbumSourceType, config: Record<string, any>): Record<string, any> {
  const allowed = ALLOWED_FIELDS_BY_TYPE[type] || [];
  const out: Record<string, any> = {};
  for (const field of allowed) {
    if (config[field] !== undefined) {
      out[field] = String(config[field]).trim();
    }
  }
  return out;
}

/**
 * GET /api/v1/admin/album-sources
 */
albumSourcesRouter.get("/album-sources", (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM album_sources ORDER BY created_at ASC").all() as any[] as AlbumSourceRow[];
  res.json({ albumSources: rows.map(serializeSource) });
});

/**
 * POST /api/v1/admin/album-sources
 */
albumSourcesRouter.post("/album-sources", (req: Request, res: Response) => {
  const { name, type, config, enabled } = req.body || {};

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ status: "error", error: "name is required." });
    return;
  }
  if (!isValidAlbumSourceType(type)) {
    res.status(400).json({ status: "error", error: `type must be one of: ${ALBUM_SOURCE_TYPES.join(", ")}.` });
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    res.status(400).json({ status: "error", error: "config must be an object." });
    return;
  }

  const sanitized = sanitizeConfigInput(type, config);
  const requiredError = validateRequiredConfig(type, sanitized);
  if (requiredError) {
    res.status(400).json({ status: "error", error: requiredError });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
  ).run(id, name.trim(), type, JSON.stringify(sanitized), enabled === false ? 0 : 1, now);

  const row = db.prepare("SELECT * FROM album_sources WHERE id = ?").get(id) as any as AlbumSourceRow;
  res.status(201).json({ status: "success", albumSource: serializeSource(row) });

  // Pull this source's photos in right away rather than waiting for the next 15-minute cron
  // tick, so a newly-added album isn't stuck showing nothing until then. Fired after the
  // response is already sent - a slow first sync (e.g. a large Google Photos album) shouldn't
  // hold up the API call that created the source.
  if (type !== "manual") {
    syncAlbumSourceNow(id).catch((err) => console.error(`[ALBUM-SOURCES] Initial sync failed for "${name}":`, err));
  }
});

/**
 * PATCH /api/v1/admin/album-sources/:id
 */
albumSourcesRouter.patch("/album-sources/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT * FROM album_sources WHERE id = ?").get(id) as any as AlbumSourceRow | undefined;
  if (!existing) {
    res.status(404).json({ status: "error", error: "Album source not found." });
    return;
  }

  const { name, config, enabled } = req.body || {};
  const type = existing.type;

  let currentConfig: Record<string, any> = {};
  try {
    currentConfig = JSON.parse(existing.config_json) || {};
  } catch {
    currentConfig = {};
  }

  if (config !== undefined) {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      res.status(400).json({ status: "error", error: "config must be an object." });
      return;
    }
    const allowed = ALLOWED_FIELDS_BY_TYPE[type] || [];
    const secretFields = new Set(SECRET_FIELDS_BY_TYPE[type] || []);
    for (const field of allowed) {
      if (config[field] === undefined) continue;
      const incoming = String(config[field]).trim();
      if (secretFields.has(field)) {
        // "Unchanged secret" sentinel - same convention as the global /settings endpoint:
        // a masked value in the request means "leave this field alone", never "clear it".
        if (incoming === SECRET_MASK || incoming === "") continue;
        currentConfig[field] = incoming;
      } else {
        currentConfig[field] = incoming;
      }
    }
  }

  let newName = existing.name;
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ status: "error", error: "name must be a non-empty string." });
      return;
    }
    newName = name.trim();
  }

  const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;

  db.prepare("UPDATE album_sources SET name = ?, config_json = ?, enabled = ? WHERE id = ?").run(
    newName,
    JSON.stringify(currentConfig),
    newEnabled,
    id
  );

  const row = db.prepare("SELECT * FROM album_sources WHERE id = ?").get(id) as any as AlbumSourceRow;
  res.json({ status: "success", albumSource: serializeSource(row) });
});

/**
 * DELETE /api/v1/admin/album-sources/:id
 *
 * Design decision (approved): deleting a source does NOT delete the photos that were
 * ingested from it - they simply become orphaned/unassigned (photos.album_source_id keeps
 * pointing at a now-nonexistent source, which getNextPhoto's JOIN-based filtering already
 * tolerates by treating them as belonging to no currently-assignable source). Only the
 * album_sources row itself and its frame_album_assignments rows are removed.
 */
albumSourcesRouter.delete("/album-sources/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM album_sources WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ status: "error", error: "Album source not found." });
    return;
  }

  db.prepare("DELETE FROM frame_album_assignments WHERE album_source_id = ?").run(id);
  db.prepare("DELETE FROM album_sources WHERE id = ?").run(id);

  res.json({ status: "success", message: `Album source ${id} removed.` });
});

/**
 * GET /api/v1/admin/frames/:id/album-sources
 */
albumSourcesRouter.get("/frames/:id/album-sources", (req: Request, res: Response) => {
  const frameId = String(req.params.id);
  const db = getDb();
  const frame = db.prepare("SELECT id FROM frames WHERE id = ?").get(frameId);
  if (!frame) {
    res.status(404).json({ status: "error", error: "Frame not found." });
    return;
  }

  const rows = db
    .prepare("SELECT album_source_id FROM frame_album_assignments WHERE frame_id = ?")
    .all(frameId) as Array<{ album_source_id: string }>;

  res.json({ albumSourceIds: rows.map((r) => r.album_source_id) });
});

/**
 * PUT /api/v1/admin/frames/:id/album-sources
 *
 * Replaces the full set of album-source assignments for a frame.
 *
 * NOTE on the empty-array case: Phase 1's `getNextPhoto` (services/queue.ts) treats "zero
 * assignment rows for this frame" as "show the whole library" (the backward-compatible
 * fallback for frames that predate this feature or were never configured). That means
 * there is currently no way to distinguish "never configured" from "explicitly assigned to
 * nothing" - both look identical (zero rows) to getNextPhoto. Rather than invent a new
 * schema concept (e.g. a `frames.album_assignment_configured` flag) to represent "explicitly
 * empty, show nothing" for this phase, we deliberately punt on that distinction: passing an
 * empty array here just deletes all assignment rows for the frame, which falls back to
 * whole-library behavior. This is called out explicitly so a future phase can revisit it
 * (e.g. add that flag) if "assigned to nothing" needs to actually mean "show nothing".
 */
albumSourcesRouter.put("/frames/:id/album-sources", (req: Request, res: Response) => {
  const frameId = String(req.params.id);
  const db = getDb();
  const frame = db.prepare("SELECT id FROM frames WHERE id = ?").get(frameId);
  if (!frame) {
    res.status(404).json({ status: "error", error: "Frame not found." });
    return;
  }

  const { albumSourceIds } = req.body || {};
  if (!Array.isArray(albumSourceIds) || !albumSourceIds.every((v) => typeof v === "string")) {
    res.status(400).json({ status: "error", error: "albumSourceIds must be an array of strings." });
    return;
  }

  if (albumSourceIds.length > 0) {
    const placeholders = albumSourceIds.map(() => "?").join(", ");
    const existingRows = db
      .prepare(`SELECT id FROM album_sources WHERE id IN (${placeholders})`)
      .all(...albumSourceIds) as Array<{ id: string }>;
    const existingIds = new Set(existingRows.map((r) => r.id));
    const missing = albumSourceIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      res.status(400).json({ status: "error", error: `Unknown album source id(s): ${missing.join(", ")}` });
      return;
    }
  }

  const now = Date.now();
  db.prepare("DELETE FROM frame_album_assignments WHERE frame_id = ?").run(frameId);
  const insert = db.prepare(
    "INSERT INTO frame_album_assignments (frame_id, album_source_id, created_at) VALUES (?, ?, ?)"
  );
  for (const sourceId of albumSourceIds) {
    insert.run(frameId, sourceId, now);
  }

  res.json({ status: "success", albumSourceIds });
});

/**
 * PATCH /api/v1/admin/frames/:id
 *
 * Updates a single frame's per-frame override columns. Each field is nullable: omitted
 * means "leave as-is", explicit `null` means "clear the override / inherit the global
 * default" (see the nullable override columns added in db/database.ts).
 */
albumSourcesRouter.patch("/frames/:id", (req: Request, res: Response) => {
  const frameId = String(req.params.id);
  const db = getDb();
  const frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(frameId) as any;
  if (!frame) {
    res.status(404).json({ status: "error", error: "Frame not found." });
    return;
  }

  const body = req.body || {};
  const updates: Record<string, any> = {};

  if ("name" in body) {
    const v = body.name;
    if (typeof v !== "string" || v.trim().length === 0) {
      res.status(400).json({ status: "error", error: "name must be a non-empty string." });
      return;
    }
    updates.name = v.trim();
  }

  if ("storageMode" in body) {
    updates.storage_mode = body.storageMode ? 1 : 0;
  }

  if ("frameOrientation" in body) {
    const v = body.frameOrientation;
    if (v !== null && !isValidFrameOrientation(v)) {
      res.status(400).json({ status: "error", error: "frameOrientation must be null or one of: portrait, portrait_180, landscape, landscape_270." });
      return;
    }
    updates.frame_orientation = v === null ? null : v;
  }

  if ("fitMode" in body) {
    const v = body.fitMode;
    if (v !== null && !isValidFitMode(v)) {
      res.status(400).json({ status: "error", error: "fitMode must be null or one of: matting, cover, rotate." });
      return;
    }
    updates.fit_mode = v === null ? null : v;
  }

  if ("epdoptimizeConfig" in body) {
    const v = body.epdoptimizeConfig;
    if (v === null) {
      updates.epdoptimize_config = null;
    } else {
      const { value, error } = validateEpdoptimizeConfig(v);
      if (error) {
        res.status(400).json({ status: "error", error });
        return;
      }
      updates.epdoptimize_config = JSON.stringify(value);
    }
  }

  if ("refreshSchedule" in body) {
    const v = body.refreshSchedule;
    if (v === null) {
      updates.refresh_schedule = null;
    } else {
      const { value, error } = validateRefreshSchedule(v);
      if (error) {
        res.status(400).json({ status: "error", error });
        return;
      }
      updates.refresh_schedule = JSON.stringify(value);
    }
  }

  const keys = Object.keys(updates);
  if (keys.length > 0) {
    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE frames SET ${setClause} WHERE id = ?`).run(...keys.map((k) => updates[k]), frameId);
  }

  const updated = db.prepare("SELECT * FROM frames WHERE id = ?").get(frameId) as any;
  let epdoptimizeConfig: unknown = null;
  if (updated.epdoptimize_config) {
    try {
      epdoptimizeConfig = JSON.parse(updated.epdoptimize_config);
    } catch {
      epdoptimizeConfig = null;
    }
  }
  let refreshSchedule: unknown = null;
  if (updated.refresh_schedule) {
    try {
      refreshSchedule = JSON.parse(updated.refresh_schedule);
    } catch {
      refreshSchedule = null;
    }
  }

  res.json({
    status: "success",
    frame: {
      ...updated,
      frameOrientation: updated.frame_orientation || null,
      fitMode: updated.fit_mode || null,
      epdoptimizeConfig,
      refreshSchedule,
      storageMode: Boolean(updated.storage_mode)
    }
  });
});

/**
 * POST /api/v1/admin/frames/:id/sync
 *
 * Syncs this frame's assigned album sources right now, rather than waiting for the next
 * 15-minute cron tick. If the frame has no explicit assignment (whole-library fallback, per
 * getNextPhoto's semantics), syncs every enabled album source instead, since any of them
 * could end up in this frame's library.
 */
albumSourcesRouter.post("/frames/:id/sync", async (req: Request, res: Response) => {
  const frameId = String(req.params.id);
  const db = getDb();
  const frame = db.prepare("SELECT id FROM frames WHERE id = ?").get(frameId);
  if (!frame) {
    res.status(404).json({ status: "error", error: "Frame not found." });
    return;
  }

  const assignedIds = (
    db.prepare("SELECT album_source_id FROM frame_album_assignments WHERE frame_id = ?").all(frameId) as Array<{
      album_source_id: string;
    }>
  ).map((r) => r.album_source_id);

  const targetIds =
    assignedIds.length > 0
      ? assignedIds
      : (db.prepare("SELECT id FROM album_sources WHERE enabled = 1").all() as Array<{ id: string }>).map((r) => r.id);

  let totalIngested = 0;
  for (const sourceId of targetIds) {
    const result = await syncAlbumSourceNow(sourceId);
    totalIngested += result?.ingested || 0;
  }

  res.json({ status: "success", sourcesSynced: targetIds.length, photosIngested: totalIngested });
});
