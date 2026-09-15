import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { getDb } from "../src/db/database.js";
import { config } from "../src/config.js";
import { ensurePhotoDownloaded, evictStaleCloudPhotos } from "../src/services/sync-scheduler.js";

/**
 * Exercises the lazy-download / eviction lifecycle for cloud-sourced photos:
 *   (a) a photo registered as metadata-only (downloaded_at NULL, no local files - the state
 *       registerPhotoPreview leaves a freshly-synced cloud photo in) gets its full original
 *       and e-paper binary fetched and rendered on ensurePhotoDownloaded, and
 *   (b) a downloaded-but-unneeded cloud photo (not currently displayed or up next on any
 *       frame, past the minimum retention age) has its heavy files reclaimed by
 *       evictStaleCloudPhotos, reverting it back to the same not-downloaded state.
 *
 * Uses a throwaway local HTTP server (not a real cloud provider) as the "original_url" source,
 * with the test photo's album_source_id left NULL so ensurePhotoDownloaded takes its
 * no-adapter direct-fetch fallback path - this validates the download/render/DB-update
 * mechanism itself without depending on real Google/Immich/iCloud credentials.
 */

async function startTestImageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const jpeg = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 100, b: 50 } }
  })
    .jpeg()
    .toBuffer();

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "image/jpeg");
    res.end(jpeg);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/photo.jpg`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("Lazy download: registers as metadata-only, then downloads on demand", async () => {
  const db = getDb();
  const testPhotoId = "test_lazy_download_photo_1";
  const testServer = await startTestImageServer();

  try {
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);

    const now = Date.now();
    db.prepare(`
      INSERT INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, orientation, uploaded_at, is_active, album_source_id, downloaded_at)
      VALUES (?, 'google_photos', 'src123', ?, '', '', 0, 0, 'unknown', ?, 1, NULL, NULL)
    `).run(testPhotoId, testServer.url, now);

    const before = db.prepare("SELECT * FROM photos WHERE id = ?").get(testPhotoId) as any;
    assert.equal(before.downloaded_at, null, "should start as not-downloaded metadata-only");
    assert.equal(before.file_path, "");

    const ok = await ensurePhotoDownloaded(testPhotoId);
    assert.equal(ok, true, "ensurePhotoDownloaded should succeed");

    const after = db.prepare("SELECT * FROM photos WHERE id = ?").get(testPhotoId) as any;
    assert.ok(after.downloaded_at, "downloaded_at should now be set");
    assert.notEqual(after.file_path, "");
    assert.notEqual(after.bin_path, "");
    assert.equal(after.width, 40);
    assert.equal(after.height, 30);
    assert.ok(fs.existsSync(after.file_path), "original file should exist on disk");
    assert.ok(fs.existsSync(after.bin_path), "rendered e-paper binary should exist on disk");
    assert.equal(fs.statSync(after.bin_path).size, 960000, "binary should be the full 960,000-byte frame buffer");

    // Idempotent: calling again when already downloaded is a no-op success, not a re-fetch.
    const secondCall = await ensurePhotoDownloaded(testPhotoId);
    assert.equal(secondCall, true);
  } finally {
    const row = db.prepare("SELECT file_path, bin_path FROM photos WHERE id = ?").get(testPhotoId) as
      | { file_path: string; bin_path: string }
      | undefined;
    if (row?.file_path) fs.rmSync(row.file_path, { force: true });
    if (row?.bin_path) fs.rmSync(row.bin_path, { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}.bin`), { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}_thumb.jpg`), { force: true });
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);
    await testServer.close();
  }
});

test("Eviction: reclaims a stale, unneeded cloud photo's heavy files", async () => {
  const db = getDb();
  const testPhotoId = "test_eviction_photo_1";
  const testServer = await startTestImageServer();

  try {
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);
    db.prepare("DELETE FROM queue WHERE photo_id = ?").run(testPhotoId);

    // is_active = 0 keeps this photo out of every frame's getNextPhoto/peekNextPhoto
    // candidate pool (those queries require is_active = 1), so it can't be spuriously
    // protected by some unrelated frame's idle-shuffle randomly picking it as "up next" on a
    // shared dev DB that may have other frames/photos. evictStaleCloudPhotos's own candidate
    // query doesn't filter by is_active, so this doesn't affect what's under test.
    db.prepare(`
      INSERT INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, orientation, uploaded_at, is_active, album_source_id, downloaded_at)
      VALUES (?, 'google_photos', 'src456', ?, '', '', 0, 0, 'unknown', ?, 0, NULL, NULL)
    `).run(testPhotoId, testServer.url, Date.now());

    const downloaded = await ensurePhotoDownloaded(testPhotoId);
    assert.equal(downloaded, true);

    const afterDownload = db.prepare("SELECT * FROM photos WHERE id = ?").get(testPhotoId) as any;
    assert.ok(fs.existsSync(afterDownload.file_path));
    assert.ok(fs.existsSync(afterDownload.bin_path));

    // Backdate downloaded_at well past the eviction retention window - otherwise a
    // just-downloaded photo is deliberately protected from immediate re-eviction churn.
    const wellPast = Date.now() - 48 * 3600 * 1000;
    db.prepare("UPDATE photos SET downloaded_at = ? WHERE id = ?").run(wellPast, testPhotoId);

    const evictedCount = await evictStaleCloudPhotos();
    assert.ok(evictedCount >= 1, "should have evicted at least this one stale photo");

    const afterEviction = db.prepare("SELECT * FROM photos WHERE id = ?").get(testPhotoId) as any;
    assert.equal(afterEviction.downloaded_at, null, "should revert to not-downloaded");
    assert.equal(afterEviction.file_path, "");
    assert.equal(afterEviction.bin_path, "");
    assert.ok(!fs.existsSync(afterDownload.file_path), "original file should be deleted");
    assert.ok(!fs.existsSync(afterDownload.bin_path), "rendered binary should be deleted");

    // Re-downloadable on demand afterwards, same as a never-downloaded photo.
    const redownloaded = await ensurePhotoDownloaded(testPhotoId);
    assert.equal(redownloaded, true);
  } finally {
    const row = db.prepare("SELECT file_path, bin_path FROM photos WHERE id = ?").get(testPhotoId) as
      | { file_path: string; bin_path: string }
      | undefined;
    if (row?.file_path) fs.rmSync(row.file_path, { force: true });
    if (row?.bin_path) fs.rmSync(row.bin_path, { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}.bin`), { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}_thumb.jpg`), { force: true });
    db.prepare("DELETE FROM queue WHERE photo_id = ?").run(testPhotoId);
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);
    await testServer.close();
  }
});

test("Eviction: protects a photo that is currently displayed on a frame", async () => {
  const db = getDb();
  const testPhotoId = "test_eviction_protected_photo_1";
  const testFrameId = "TEST-EVICTION-PROTECTED-FRAME";
  const testServer = await startTestImageServer();

  try {
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);
    db.prepare("DELETE FROM frames WHERE id = ?").run(testFrameId);

    db.prepare(`
      INSERT INTO photos (id, source, source_id, original_url, file_path, bin_path, width, height, orientation, uploaded_at, is_active, album_source_id, downloaded_at)
      VALUES (?, 'google_photos', 'src789', ?, '', '', 0, 0, 'unknown', ?, 1, NULL, NULL)
    `).run(testPhotoId, testServer.url, Date.now());

    await ensurePhotoDownloaded(testPhotoId);
    const wellPast = Date.now() - 48 * 3600 * 1000;
    db.prepare("UPDATE photos SET downloaded_at = ? WHERE id = ?").run(wellPast, testPhotoId);

    // Frame currently displaying exactly this photo - must be protected from eviction.
    db.prepare(`
      INSERT INTO frames (id, name, last_checkin_at, last_refresh_at, current_image_id, created_at)
      VALUES (?, 'Protected Frame', NULL, NULL, ?, ?)
    `).run(testFrameId, testPhotoId, Date.now());

    await evictStaleCloudPhotos();

    const after = db.prepare("SELECT downloaded_at FROM photos WHERE id = ?").get(testPhotoId) as { downloaded_at: number | null };
    assert.ok(after.downloaded_at, "currently-displayed photo must not be evicted");
  } finally {
    const row = db.prepare("SELECT file_path, bin_path FROM photos WHERE id = ?").get(testPhotoId) as
      | { file_path: string; bin_path: string }
      | undefined;
    if (row?.file_path) fs.rmSync(row.file_path, { force: true });
    if (row?.bin_path) fs.rmSync(row.bin_path, { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}.bin`), { force: true });
    fs.rmSync(path.join(config.cacheDir, `${testPhotoId}_thumb.jpg`), { force: true });
    db.prepare("DELETE FROM photos WHERE id = ?").run(testPhotoId);
    db.prepare("DELETE FROM frames WHERE id = ?").run(testFrameId);
    await testServer.close();
  }
});
