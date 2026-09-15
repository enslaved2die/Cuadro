import test from "node:test";
import assert from "node:assert/strict";
import { secondsUntilNextScheduledTime, isValidScheduleTime, isValidTimezone } from "../src/services/schedule.js";

test("Schedule: validates HH:MM time format", () => {
  assert.equal(isValidScheduleTime("07:00"), true);
  assert.equal(isValidScheduleTime("23:59"), true);
  assert.equal(isValidScheduleTime("00:00"), true);
  assert.equal(isValidScheduleTime("24:00"), false);
  assert.equal(isValidScheduleTime("7:00"), false);
  assert.equal(isValidScheduleTime("not-a-time"), false);
});

test("Schedule: validates IANA timezone names", () => {
  assert.equal(isValidTimezone("America/Bogota"), true);
  assert.equal(isValidTimezone("Europe/Berlin"), true);
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(isValidTimezone(""), false);
});

test("Schedule: computes seconds until a same-day future time in another timezone", () => {
  // 2024-01-15 10:00:00 UTC == 2024-01-15 05:00:00 America/Bogota (UTC-5, no DST)
  const from = new Date("2024-01-15T10:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime("07:00", "America/Bogota", from);
  // 07:00 Bogota == 12:00 UTC, which is 2 hours after `from`.
  assert.equal(seconds, 2 * 3600);
});

test("Schedule: rolls over to tomorrow when the target time already passed today", () => {
  // 2024-01-15 10:00:00 UTC == 2024-01-15 05:00:00 America/Bogota
  const from = new Date("2024-01-15T10:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime("03:00", "America/Bogota", from);
  // 03:00 Bogota already passed (it's 05:00 there); next occurrence is tomorrow 03:00
  // Bogota == 2024-01-16T08:00:00Z, i.e. 22 hours after `from`.
  assert.equal(seconds, 22 * 3600);
});

test("Schedule: falls back to UTC/07:00 for invalid input instead of throwing", () => {
  const from = new Date("2024-01-15T00:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime("bogus", "Not/AZone", from);
  assert.equal(seconds, 7 * 3600);
});

test("Schedule: always returns at least 60 seconds", () => {
  const from = new Date("2024-01-15T07:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime("07:00", "UTC", from);
  assert.ok(seconds >= 60);
});

test("Schedule: picks the soonest of multiple daily times", () => {
  // 10:00 UTC. Candidates today: 07:00 (passed -> tomorrow, 21h), 19:00 (9h away), 23:00 (13h away).
  const from = new Date("2024-01-15T10:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime(["07:00", "19:00", "23:00"], "UTC", from);
  assert.equal(seconds, 9 * 3600);
});

test("Schedule: multiple times all in the past today all roll to tomorrow, picks earliest", () => {
  // 22:00 UTC. Both 07:00 and 09:00 have passed; next occurrences are tomorrow.
  const from = new Date("2024-01-15T22:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime(["09:00", "07:00"], "UTC", from);
  // Tomorrow 07:00 UTC is 9 hours away.
  assert.equal(seconds, 9 * 3600);
});

test("Schedule: ignores invalid entries in a times array", () => {
  const from = new Date("2024-01-15T10:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime(["not-a-time", "19:00"], "UTC", from);
  assert.equal(seconds, 9 * 3600);
});

test("Schedule: empty times array falls back to 07:00 UTC", () => {
  const from = new Date("2024-01-15T00:00:00.000Z");
  const seconds = secondsUntilNextScheduledTime([], "UTC", from);
  assert.equal(seconds, 7 * 3600);
});
