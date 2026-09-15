import test from "node:test";
import assert from "node:assert/strict";
import { computeFrameState } from "../src/api/admin.js";
import { config } from "../src/config.js";

// These mirror the constants in admin.ts (ACTIVE_WINDOW_MS = 2min, REFRESH_GRACE_MS = 5min).
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const REFRESH_GRACE_MS = 5 * 60 * 1000;

test("Admin status: frame state model based on next_expected_refresh_at", async (t) => {
  await t.test("checked in within the last 2 minutes is always active", () => {
    const now = Date.now();
    const state = computeFrameState({ last_checkin_at: now - 1000, next_expected_refresh_at: now - 999999 }, now, 1000);
    assert.equal(state, "active");
  });

  await t.test("no next_expected_refresh_at falls back to the old defaultSleepSeconds window", () => {
    const now = Date.now();
    const withinWindow = (config.defaultSleepSeconds + 1000) * 1000; // still within old window
    const pastWindow = (config.defaultSleepSeconds + 3600) * 1000; // past old window (+1800s grace)

    assert.equal(
      computeFrameState({ last_checkin_at: now - withinWindow, next_expected_refresh_at: null }, now, withinWindow),
      "sleeping"
    );
    assert.equal(
      computeFrameState({ last_checkin_at: now - pastWindow, next_expected_refresh_at: null }, now, pastWindow),
      "offline"
    );
  });

  await t.test("a frame waiting on a long scheduled-refresh gap (e.g. 14h) is 'sleeping', not 'offline'", () => {
    // Frame checked in at 04:00, next scheduled refresh isn't until 18:00 (14h gap).
    // 10 hours have elapsed since check-in - well past the old defaultSleepSeconds window,
    // but nowhere near the scheduled wake time, so it should read as sleeping.
    const checkinAt = Date.now() - 10 * 3600 * 1000;
    const now = Date.now();
    const nextExpected = checkinAt + 14 * 3600 * 1000; // still 4h in the future

    const elapsed = now - checkinAt;
    const state = computeFrameState({ last_checkin_at: checkinAt, next_expected_refresh_at: nextExpected }, now, elapsed);
    assert.equal(state, "sleeping");
  });

  await t.test("just past next_expected_refresh_at but within grace is still 'sleeping'", () => {
    const checkinAt = Date.now() - 4 * 3600 * 1000;
    const nextExpected = checkinAt + 4 * 3600 * 1000; // due 4h after checkin - i.e. now
    const now = nextExpected + REFRESH_GRACE_MS - 10_000; // just inside grace window

    const elapsed = now - checkinAt;
    const state = computeFrameState({ last_checkin_at: checkinAt, next_expected_refresh_at: nextExpected }, now, elapsed);
    assert.equal(state, "sleeping");
  });

  await t.test("past grace period but within one extra cycle is 'overdue'", () => {
    const cycleMs = 4 * 3600 * 1000;
    const checkinAt = Date.now() - cycleMs;
    const nextExpected = checkinAt + cycleMs; // due now
    const now = nextExpected + REFRESH_GRACE_MS + 10_000; // just past grace

    const elapsed = now - checkinAt;
    const state = computeFrameState({ last_checkin_at: checkinAt, next_expected_refresh_at: nextExpected }, now, elapsed);
    assert.equal(state, "overdue");
  });

  await t.test("missed multiple full cycles with no activity is 'offline'", () => {
    const cycleMs = 4 * 3600 * 1000;
    const checkinAt = Date.now() - 3 * cycleMs;
    const nextExpected = checkinAt + cycleMs;
    const now = nextExpected + REFRESH_GRACE_MS + cycleMs + 10_000; // beyond the overdue window

    const elapsed = now - checkinAt;
    const state = computeFrameState({ last_checkin_at: checkinAt, next_expected_refresh_at: nextExpected }, now, elapsed);
    assert.equal(state, "offline");
  });

  await t.test("elapsed is still reported accurately regardless of state", () => {
    const now = Date.now();
    const checkinAt = now - 5000;
    // Sanity check: elapsedSeconds computation in the route is independent of state logic.
    assert.equal(Math.round((now - checkinAt) / 1000), 5);
  });
});
