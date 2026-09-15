import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { evaluateFrameWatchdog, recordFrameActivity } from "../src/services/watchdog.js";
import { setFrameStorageMode, isFrameStorageModeEnabled } from "../src/services/queue.js";

test("Watchdog: Evaluates 24-hour cycle and storage mode", () => {
  const db = getDb();
  const testFrameId = "AA:BB:CC:DD:EE:FF";

  // 1. Initial checkin
  recordFrameActivity(testFrameId, 4.12, "1.0.0", true);

  const initialEval = evaluateFrameWatchdog(testFrameId);
  assert.equal(initialEval.shouldForceRefresh, false);
  assert.ok(initialEval.recommendedSleepSeconds > 0);

  // 2. Simulate 23 hours elapsed since last refresh
  const twentyThreeHoursAgo = Date.now() - (23 * 3600 * 1000);
  db.prepare("UPDATE frames SET last_refresh_at = ? WHERE id = ?").run(twentyThreeHoursAgo, testFrameId);

  const forcedEval = evaluateFrameWatchdog(testFrameId);
  assert.equal(forcedEval.shouldForceRefresh, true, "Should force refresh when 23 hours have elapsed");

  // 3. Storage Mode Toggle (per-frame, not global)
  setFrameStorageMode(testFrameId, true);
  assert.equal(isFrameStorageModeEnabled(testFrameId), true);

  setFrameStorageMode(testFrameId, false);
  assert.equal(isFrameStorageModeEnabled(testFrameId), false);
});
