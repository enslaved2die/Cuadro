import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initSchema, migrateAlbumSourcesV2, getDb } from "../src/db/database.js";
import { reloadConfigFromDb, config } from "../src/config.js";
import { getNextPhoto, enqueuePhoto } from "../src/services/queue.js";
import { evaluateFrameWatchdog, recordFrameActivity } from "../src/services/watchdog.js";

/**
 * These tests exercise the Phase 1 multi-frame data-model foundation:
 *   (a) the one-time legacy-settings -> album_sources migration,
 *   (b) getNextPhoto(frameId) source-scoping (with backward-compatible fallback),
 *   (c) per-frame refresh_schedule overrides in the watchdog.
 *
 * (a) uses a throwaway temp SQLite file (never the shared dev/prod database) so it can
 * freely exercise "migration runs against fresh legacy settings" without depending on
 * whether the real dev DB has already been migrated. (b) and (c) use the shared `getDb()`
 * instance (as watchdog.test.ts and admin-status.test.ts already do), with unique
 * test-prefixed frame/photo/source IDs so they can't collide with real data.
 */

test("Multi-frame Phase 1: one-time album_sources migration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuadro-migration-test-"));
  const tmpDbPath = path.join(tmpDir, "test.sqlite");
  const db = new DatabaseSync(tmpDbPath);

  try {
    initSchema(db);

    // Seed legacy flat settings as if this were an old single-frame deployment with
    // Google Photos (public share link) and Immich configured, but iCloud left blank.
    const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    upsert.run("google_photos_share_url", "https://photos.app.goo.gl/abc123");
    upsert.run("immich_host", "https://immich.example.com");
    upsert.run("immich_api_key", "test-api-key");
    upsert.run("immich_album_id", "album-uuid-123");
    // iCloud intentionally left unconfigured.

    // Seed one pre-existing frame, as a real single-frame deployment would have.
    const now = Date.now();
    db.prepare(`
      INSERT INTO frames (id, name, created_at)
      VALUES (?, ?, ?)
    `).run("legacy-frame-1", "Legacy Frame", now);

    reloadConfigFromDb(db as any);
    migrateAlbumSourcesV2(db);

    // Exactly two sources should have been created (Google Photos + Immich, not iCloud).
    const sources = db.prepare("SELECT * FROM album_sources ORDER BY type").all() as any[];
    assert.equal(sources.length, 2);

    const googleSource = sources.find((s) => s.type === "google_photos");
    const immichSource = sources.find((s) => s.type === "immich");
    assert.ok(googleSource, "Google Photos source should be created");
    assert.ok(immichSource, "Immich source should be created");
    assert.equal(googleSource.enabled, 1);
    const googleCfg = JSON.parse(googleSource.config_json);
    assert.equal(googleCfg.shareUrl, "https://photos.app.goo.gl/abc123");
    const immichCfg = JSON.parse(immichSource.config_json);
    assert.equal(immichCfg.host, "https://immich.example.com");
    assert.equal(immichCfg.apiKey, "test-api-key");
    assert.equal(immichCfg.albumId, "album-uuid-123");

    // The pre-existing frame should be assigned to BOTH newly created sources
    // ("assign everything to everything" - preserves today's single-global-queue behavior).
    const assignments = db
      .prepare("SELECT album_source_id FROM frame_album_assignments WHERE frame_id = ?")
      .all("legacy-frame-1") as Array<{ album_source_id: string }>;
    assert.equal(assignments.length, 2);
    const assignedIds = new Set(assignments.map((a) => a.album_source_id));
    assert.ok(assignedIds.has(googleSource.id));
    assert.ok(assignedIds.has(immichSource.id));

    // The frame's per-frame override columns should be snapshotted from the (post-reload)
    // global config, not left null, so future global-default changes can't alter it.
    const frameRow = db.prepare("SELECT * FROM frames WHERE id = ?").get("legacy-frame-1") as any;
    assert.equal(frameRow.frame_orientation, config.frameOrientation);
    assert.equal(frameRow.fit_mode, config.fitMode);
    assert.deepEqual(JSON.parse(frameRow.epdoptimize_config), config.epdoptimizeConfig);
    assert.deepEqual(JSON.parse(frameRow.refresh_schedule), config.refreshSchedule);

    // The migration flag should now be set, and running it again should be a strict no-op
    // (no duplicate sources/assignments created).
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'migrated_v2_album_sources'").get() as any;
    assert.equal(flag.value, "1");

    migrateAlbumSourcesV2(db); // run again
    const sourcesAfterRerun = db.prepare("SELECT * FROM album_sources").all() as any[];
    assert.equal(sourcesAfterRerun.length, 2, "migration must never re-run once the flag is set");
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Multi-frame Phase 1: getNextPhoto(frameId) source scoping", () => {
  const db = getDb();
  const now = Date.now();

  const sourceAId = `test-src-a-${crypto.randomUUID()}`;
  const sourceBId = `test-src-b-${crypto.randomUUID()}`;
  const photoAId = `test-photo-a-${crypto.randomUUID()}`;
  const photoBId = `test-photo-b-${crypto.randomUUID()}`;
  const assignedFrameId = `test-frame-assigned-${crypto.randomUUID()}`;
  const unassignedFrameId = `test-frame-unassigned-${crypto.randomUUID()}`;

  try {
    db.prepare(`
      INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at)
      VALUES (?, 'Test Source A', 'immich', '{}', 1, NULL, ?)
    `).run(sourceAId, now);
    db.prepare(`
      INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at)
      VALUES (?, 'Test Source B', 'immich', '{}', 1, NULL, ?)
    `).run(sourceBId, now);

    const insertPhoto = db.prepare(`
      INSERT INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, uploaded_at, is_active, album_source_id)
      VALUES (?, 'immich', ?, '', '/nonexistent/file.jpg', '/nonexistent/file.bin', 100, 100, ?, 1, ?)
    `);
    insertPhoto.run(photoAId, photoAId, now, sourceAId);
    insertPhoto.run(photoBId, photoBId, now, sourceBId);

    // Frame with NO recorded assignment: must see the full active library unfiltered
    // (the deliberate backward-compatible default for pre-migration/new frames). These two
    // freshly-inserted photos are (deterministically, since this test cleans up after
    // itself) the only active/pending-queue photos in the library at this point, so the
    // unassigned frame drawing either one via the idle shuffle proves it isn't source-filtered.
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const p = getNextPhoto(unassignedFrameId);
      if (p) seen.add(p.id);
    }
    assert.ok(seen.has(photoAId), "unfiltered frame should be able to see photo A");
    assert.ok(seen.has(photoBId), "unfiltered frame should be able to see photo B");

    // Frame assigned ONLY to source A: must only ever receive photo A, never photo B.
    // frame_album_assignments.frame_id has a FK to frames(id), so the frame row must exist first.
    db.prepare("INSERT INTO frames (id, name, created_at) VALUES (?, ?, ?)").run(assignedFrameId, "Test Frame A", now);
    db.prepare("INSERT INTO frame_album_assignments (frame_id, album_source_id, created_at) VALUES (?, ?, ?)").run(
      assignedFrameId,
      sourceAId,
      now
    );

    for (let i = 0; i < 5; i++) {
      const p = getNextPhoto(assignedFrameId);
      assert.ok(p, "assigned frame should get a photo");
      assert.equal(p!.id, photoAId, "assigned frame must only ever see photos from its assigned source");
    }

    // Also verify the priority-queue path respects the same scoping: queue photo B with
    // high priority for the frame assigned only to source A - it must still be skipped.
    enqueuePhoto(photoBId, 100);
    const stillA = getNextPhoto(assignedFrameId);
    assert.ok(stillA);
    assert.equal(stillA!.id, photoAId, "queued photo from an unassigned source must be skipped");

    // Sanity: the unassigned frame, by contrast, DOES see the queued high-priority photo B.
    const unfilteredSeesQueued = getNextPhoto(unassignedFrameId);
    assert.ok(unfilteredSeesQueued);
    assert.equal(unfilteredSeesQueued!.id, photoBId);
  } finally {
    // Clean up so this test stays deterministic across repeated runs against the shared dev DB.
    db.prepare("DELETE FROM queue WHERE photo_id IN (?, ?)").run(photoAId, photoBId);
    db.prepare("DELETE FROM photos WHERE id IN (?, ?)").run(photoAId, photoBId);
    db.prepare("DELETE FROM frame_album_assignments WHERE frame_id IN (?, ?)").run(assignedFrameId, unassignedFrameId);
    db.prepare("DELETE FROM album_sources WHERE id IN (?, ?)").run(sourceAId, sourceBId);
    db.prepare("DELETE FROM frames WHERE id IN (?, ?)").run(assignedFrameId, unassignedFrameId);
  }
});

test("Multi-frame Phase 1: per-frame refresh_schedule override", () => {
  const db = getDb();
  const now = Date.now();

  // Save/restore the global config so this test can't bleed into others in the same process.
  const originalGlobalSchedule = config.refreshSchedule;
  config.refreshSchedule = { enabled: false, times: ["07:00"], timezone: "UTC" };

  try {
    const frameWithOverrideId = `test-frame-schedule-override-${crypto.randomUUID()}`;
    const frameWithoutOverrideId = `test-frame-schedule-default-${crypto.randomUUID()}`;

    recordFrameActivity(frameWithOverrideId, 4.0, "1.0.0", true);
    recordFrameActivity(frameWithoutOverrideId, 4.0, "1.0.0", true);

    // Give the override frame an enabled scheduled-refresh time far in the future,
    // distinct from the (disabled -> fixed-interval) global default.
    const overrideSchedule = { enabled: true, times: ["23:59"], timezone: "UTC" };
    db.prepare("UPDATE frames SET refresh_schedule = ? WHERE id = ?").run(
      JSON.stringify(overrideSchedule),
      frameWithOverrideId
    );

    const overrideEval = evaluateFrameWatchdog(frameWithOverrideId);
    const defaultEval = evaluateFrameWatchdog(frameWithoutOverrideId);

    // The default frame falls back to the global (disabled) schedule -> fixed defaultSleepSeconds
    // (or a smaller watchdog-clamped value, but never the scheduled-time-based computation).
    // The override frame computes "seconds until 23:59 UTC", which will differ from the
    // fixed interval in virtually every real run.
    assert.notEqual(
      overrideEval.recommendedSleepSeconds,
      defaultEval.recommendedSleepSeconds,
      "a frame with a refresh_schedule override should get a different recommended sleep than one without"
    );

    // Malformed JSON in the column must fall back to the global default rather than throwing.
    const malformedFrameId = `test-frame-schedule-malformed-${crypto.randomUUID()}`;
    recordFrameActivity(malformedFrameId, 4.0, "1.0.0", true);
    db.prepare("UPDATE frames SET refresh_schedule = ? WHERE id = ?").run("{not valid json", malformedFrameId);
    assert.doesNotThrow(() => evaluateFrameWatchdog(malformedFrameId));

    db.prepare("DELETE FROM frames WHERE id IN (?, ?, ?)").run(
      frameWithOverrideId,
      frameWithoutOverrideId,
      malformedFrameId
    );
  } finally {
    config.refreshSchedule = originalGlobalSchedule;
  }
});
