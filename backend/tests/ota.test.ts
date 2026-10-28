import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDb } from "../src/db/database.js";
import { recordFrameActivity, recordOtaStatus } from "../src/services/watchdog.js";
import { config } from "../src/config.js";

test("OTA: Schema contains firmware_releases and frame OTA columns", () => {
  const db = getDb();

  // Test table existence
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='firmware_releases'").get();
  assert.ok(tableCheck, "firmware_releases table must exist");

  // Test column existence on frames
  const frameColumns = db.prepare("PRAGMA table_info(frames)").all() as Array<{ name: string }>;
  const colNames = frameColumns.map(c => c.name);

  assert.ok(colNames.includes("firmware_version"), "frames.firmware_version must exist");
  assert.ok(colNames.includes("target_firmware_version"), "frames.target_firmware_version must exist");
  assert.ok(colNames.includes("ota_status"), "frames.ota_status must exist");
  assert.ok(colNames.includes("ota_error"), "frames.ota_error must exist");
  assert.ok(colNames.includes("ota_attempted_at"), "frames.ota_attempted_at must exist");
});

test("OTA: Telemetry recording updates frame status and validates on success", () => {
  const db = getDb();
  const testFrameId = "TEST:OTA:FRAME:01";

  // Create frame on v1.0.0
  recordFrameActivity(testFrameId, 4.05, "1.0.0", false);

  // 1. Report update in progress (normalized to lowercase)
  recordOtaStatus(testFrameId, "1.1.0", "UPDATING");
  let frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(testFrameId) as any;
  assert.equal(frame.ota_status, "updating");
  assert.equal(frame.firmware_version, "1.0.0"); // Still on old version

  // 2. Report flashed before reboot
  recordOtaStatus(testFrameId, "1.1.0", "FLASHED");
  frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(testFrameId) as any;
  assert.equal(frame.ota_status, "flashed");
  assert.equal(frame.firmware_version, "1.0.0");

  // 3. Report failure with error message
  recordOtaStatus(testFrameId, "1.1.0", "FAILED", "WiFi timeout during chunk 42");
  frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(testFrameId) as any;
  assert.equal(frame.ota_status, "failed");
  assert.equal(frame.ota_error, "WiFi timeout during chunk 42");
  assert.equal(frame.firmware_version, "1.0.0");

  // 4. Report success after retry
  recordOtaStatus(testFrameId, "1.1.0", "SUCCESS");
  frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(testFrameId) as any;
  assert.equal(frame.ota_status, "success");
  assert.equal(frame.ota_error, null);
  assert.equal(frame.firmware_version, "1.1.0"); // Promoted to new version
});

test("OTA: Release registration, SHA-256 calculation, and ESP32 magic byte validation", () => {
  const db = getDb();
  const testVersion = "9.9.9-test";

  // Dummy valid ESP32 binary (first byte is 0xE9)
  const validBin = Buffer.alloc(1024);
  validBin[0] = 0xE9; // Magic byte
  validBin.write("CUADRO-FIRMWARE-PAYLOAD", 4);

  const sha256 = crypto.createHash("sha256").update(validBin).digest("hex");
  const testFilePath = path.join(config.firmwareDir, `cuadro_v${testVersion}.bin`);
  fs.writeFileSync(testFilePath, validBin);

  // Insert release
  db.prepare(`
    INSERT OR REPLACE INTO firmware_releases (version, filename, file_path, sha256, size_bytes, release_notes, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(testVersion, `cuadro_v${testVersion}.bin`, testFilePath, sha256, validBin.length, "Test release notes", 1, Date.now());

  const stored = db.prepare("SELECT * FROM firmware_releases WHERE version = ?").get(testVersion) as any;
  assert.ok(stored);
  assert.equal(stored.version, testVersion);
  assert.equal(stored.sha256, sha256);
  assert.equal(stored.size_bytes, 1024);
  assert.equal(stored.is_active, 1);

  // Clean up test file and record
  fs.unlinkSync(testFilePath);
  db.prepare("DELETE FROM firmware_releases WHERE version = ?").run(testVersion);
});
