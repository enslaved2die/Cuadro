import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config, reloadConfigFromDb, ADMIN_PASSWORD_ENV_SET } from "../config.js";

const ADMIN_PASSWORD_SETTING_KEY = "admin_password_generated";

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  if (!fs.existsSync(config.cacheDir)) {
    fs.mkdirSync(config.cacheDir, { recursive: true });
  }

  dbInstance = new DatabaseSync(config.dbPath);
  dbInstance.exec("PRAGMA journal_mode = WAL;");
  dbInstance.exec("PRAGMA synchronous = NORMAL;");
  // Retry internally on a transient lock instead of throwing immediately - relevant mainly
  // to `npm test`, where Node's test runner spawns one process per test file and several of
  // them open this same on-disk database concurrently.
  dbInstance.exec("PRAGMA busy_timeout = 5000;");

  initSchema(dbInstance);
  reloadConfigFromDb(dbInstance);
  migrateAlbumSourcesV2(dbInstance);

  if (!ADMIN_PASSWORD_ENV_SET) {
    ensureGeneratedAdminPassword(dbInstance);
  }

  return dbInstance;
}

// When no ADMIN_PASSWORD is set in the environment, generate a strong random password on
// first boot and persist it in the settings table so it survives restarts, instead of
// falling back to a hardcoded default that's public in this open-source repo. On every
// subsequent boot (still with no ADMIN_PASSWORD env var), re-load and re-print the stored
// password so the admin doesn't lose access to it.
function ensureGeneratedAdminPassword(db: DatabaseSync) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(ADMIN_PASSWORD_SETTING_KEY) as
      | { value: string }
      | undefined;

    let password: string;
    if (row && row.value) {
      password = row.value;
    } else {
      password = crypto.randomBytes(9).toString("base64url");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(ADMIN_PASSWORD_SETTING_KEY, password);
    }

    config.adminPassword = password;

    console.log(`=======================================================`);
    console.log(` No ADMIN_PASSWORD set - generated a secure password:`);
    console.log(``);
    console.log(`   ${password}`);
    console.log(``);
    console.log(` Use this to log in to the Admin Web UI, or set`);
    console.log(` ADMIN_PASSWORD in your .env file to override it permanently.`);
    console.log(`=======================================================`);
  } catch (err) {
    // If this somehow fails, leave config.adminPassword as-is (empty string from config.ts)
    // rather than crashing startup.
  }
}

export function initSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_checkin_at INTEGER,
      last_refresh_at INTEGER,
      battery_voltage REAL,
      firmware_version TEXT,
      current_image_id TEXT,
      next_expected_refresh_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT,
      original_url TEXT,
      file_path TEXT NOT NULL,
      bin_path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      shown_count INTEGER DEFAULT 0,
      last_shown_at INTEGER,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT
    );

    CREATE TABLE IF NOT EXISTS album_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,              -- 'google_photos' | 'immich' | 'icloud'
      config_json TEXT NOT NULL,       -- JSON blob, shape depends on type
      enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS frame_album_assignments (
      frame_id TEXT NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
      album_source_id TEXT NOT NULL REFERENCES album_sources(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (frame_id, album_source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_photos_uploaded_at ON photos(uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_photos_last_shown ON photos(last_shown_at);
    CREATE INDEX IF NOT EXISTS idx_queue_pending ON queue(status, priority DESC, scheduled_at ASC);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_album_sources_type ON album_sources(type);
    CREATE INDEX IF NOT EXISTS idx_faa_album_source ON frame_album_assignments(album_source_id);
  `);

  // Migration: add orientation column to photos if missing
  try {
    db.exec("ALTER TABLE photos ADD COLUMN orientation TEXT;");
  } catch (e) {
    // Column already exists
  }

  // Migration: add current_image_id / next_expected_refresh_at columns to frames if missing
  try {
    db.exec("ALTER TABLE frames ADD COLUMN current_image_id TEXT;");
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE frames ADD COLUMN next_expected_refresh_at INTEGER;");
  } catch (e) {
    // Column already exists
  }

  // Migration: per-frame config columns (nullable = inherit the global default).
  try {
    db.exec("ALTER TABLE photos ADD COLUMN album_source_id TEXT;");
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE frames ADD COLUMN frame_orientation TEXT;");
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE frames ADD COLUMN fit_mode TEXT;");
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE frames ADD COLUMN epdoptimize_config TEXT;");
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE frames ADD COLUMN refresh_schedule TEXT;");
  } catch (e) {
    // Column already exists
  }

  // Migration: cloud-sourced photos can now exist as lightweight metadata + a small cached
  // preview only, deferring the full-resolution original and e-paper render until the photo
  // is actually about to be shown (see sync-scheduler.ts's registerPhotoPreview /
  // ensurePhotoDownloaded). `downloaded_at` is NULL for such not-yet-fully-fetched rows, and
  // set once the full original/bin have been fetched. Every pre-existing row already has its
  // original/bin on disk, so they're backfilled as "downloaded" at their original upload time
  // rather than treated as pending.
  try {
    db.exec("ALTER TABLE photos ADD COLUMN downloaded_at INTEGER;");
    db.exec("UPDATE photos SET downloaded_at = uploaded_at WHERE downloaded_at IS NULL;");
  } catch (e) {
    // Column already exists
  }

  // Migration: storage mode moves from a single global settings flag to a per-frame column
  // (each frame now has its own Panel Operation Mode, since a fleet of frames should not all
  // go into storage mode together). Carries the old global value forward as every existing
  // frame's starting value so behavior doesn't silently change on upgrade, then the legacy
  // settings row is no longer read anywhere.
  try {
    db.exec("ALTER TABLE frames ADD COLUMN storage_mode INTEGER DEFAULT 0;");
    const legacyStorageMode = db.prepare("SELECT value FROM settings WHERE key = 'storage_mode'").get() as
      | { value: string }
      | undefined;
    if (legacyStorageMode?.value === "1") {
      db.exec("UPDATE frames SET storage_mode = 1;");
    }
  } catch (e) {
    // Column already exists
  }

  // Default settings
  const checkSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  if (!checkSetting.get("auto_shuffle")) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("auto_shuffle", "1");
  }
  if (!checkSetting.get("frame_orientation")) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("frame_orientation", "portrait");
  }
  if (!checkSetting.get("fit_mode")) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("fit_mode", "matting");
  }
}

const ALBUM_SOURCES_MIGRATION_FLAG_KEY = "migrated_v2_album_sources";

/**
 * One-time data migration (Phase 1 of the multi-frame architecture): turns the legacy
 * flat `google_photos_*` / `immich_*` / `icloud_shared_album_token` settings rows into
 * proper `album_sources` rows, and assigns every existing frame to every newly created
 * source ("assign everything to everything") - this exactly preserves today's behavior,
 * where one global queue feeds every frame. It also snapshots the current global
 * orientation/fit-mode/epdoptimize-config/refresh-schedule onto each existing frame's new
 * per-frame override columns, so an already-deployed frame's behavior can never change
 * later just because a future "Defaults" tab edits the global default.
 *
 * Reads the legacy settings rows directly (rather than via `config`) so it has no
 * dependency on call ordering relative to `reloadConfigFromDb` for the adapter configs;
 * the frame-column snapshot step intentionally DOES read `config` (frameOrientation,
 * fitMode, epdoptimizeConfig, refreshSchedule), so this must run after
 * `reloadConfigFromDb(db)` has populated it from the current DB state.
 *
 * Guarded by the `migrated_v2_album_sources` settings flag so it only ever runs once;
 * wrapped in try/catch so a failure here can never crash startup, matching the
 * defensive style used by `ensureGeneratedAdminPassword`.
 */
export function migrateAlbumSourcesV2(db: DatabaseSync): void {
  try {
    const flagRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(ALBUM_SOURCES_MIGRATION_FLAG_KEY) as
      | { value: string }
      | undefined;
    if (flagRow && flagRow.value === "1") {
      return; // Already migrated - never re-run.
    }

    const getSetting = (key: string): string => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? "";
    };

    const now = Date.now();
    const insertSource = db.prepare(
      "INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at) VALUES (?, ?, ?, ?, 1, NULL, ?)"
    );
    const createdSourceIds: string[] = [];

    // Google Photos: mirrors GooglePhotosAdapter#isEnabled - either a public share URL, or
    // all four OAuth fields.
    const googlePhotosConfig = {
      shareUrl: getSetting("google_photos_share_url"),
      clientId: getSetting("google_photos_client_id"),
      clientSecret: getSetting("google_photos_client_secret"),
      refreshToken: getSetting("google_photos_refresh_token"),
      albumId: getSetting("google_photos_album_id")
    };
    const googlePhotosEnabled = Boolean(
      googlePhotosConfig.shareUrl ||
      (googlePhotosConfig.clientId &&
       googlePhotosConfig.clientSecret &&
       googlePhotosConfig.refreshToken &&
       googlePhotosConfig.albumId)
    );
    if (googlePhotosEnabled) {
      const id = crypto.randomUUID();
      insertSource.run(id, "Google Photos", "google_photos", JSON.stringify(googlePhotosConfig), now);
      createdSourceIds.push(id);
    }

    // Immich: mirrors ImmichAdapter#isEnabled.
    const immichConfig = {
      host: getSetting("immich_host"),
      apiKey: getSetting("immich_api_key"),
      albumId: getSetting("immich_album_id")
    };
    const immichEnabled = Boolean(immichConfig.host && immichConfig.apiKey && immichConfig.albumId);
    if (immichEnabled) {
      const id = crypto.randomUUID();
      insertSource.run(id, "Immich", "immich", JSON.stringify(immichConfig), now);
      createdSourceIds.push(id);
    }

    // iCloud: mirrors ICloudAdapter#isEnabled.
    const icloudConfig = { token: getSetting("icloud_shared_album_token") };
    const icloudEnabled = Boolean(icloudConfig.token);
    if (icloudEnabled) {
      const id = crypto.randomUUID();
      insertSource.run(id, "iCloud Shared Album", "icloud", JSON.stringify(icloudConfig), now);
      createdSourceIds.push(id);
    }

    // Assign every existing frame to every newly created source, and snapshot the
    // current global per-frame-overridable settings onto each existing frame row.
    const frames = db.prepare("SELECT id FROM frames").all() as Array<{ id: string }>;
    const insertAssignment = db.prepare(
      "INSERT OR IGNORE INTO frame_album_assignments (frame_id, album_source_id, created_at) VALUES (?, ?, ?)"
    );
    const snapshotFrameDefaults = db.prepare(
      "UPDATE frames SET frame_orientation = ?, fit_mode = ?, epdoptimize_config = ?, refresh_schedule = ? WHERE id = ?"
    );

    for (const frame of frames) {
      for (const sourceId of createdSourceIds) {
        insertAssignment.run(frame.id, sourceId, now);
      }
      snapshotFrameDefaults.run(
        config.frameOrientation,
        config.fitMode,
        JSON.stringify(config.epdoptimizeConfig),
        JSON.stringify(config.refreshSchedule),
        frame.id
      );
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      ALBUM_SOURCES_MIGRATION_FLAG_KEY,
      "1"
    );
  } catch (err) {
    console.warn("[MIGRATION] album_sources v2 migration failed (non-fatal, will retry on next boot):", err);
  }
}
