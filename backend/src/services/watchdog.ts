import { getDb } from "../db/database.js";
import { config, RefreshSchedule } from "../config.js";
import { secondsUntilNextScheduledTime } from "./schedule.js";

export interface WatchdogEvaluation {
  shouldForceRefresh: boolean;
  recommendedSleepSeconds: number;
}

/**
 * The "desired" sleep interval before the 24-hour safety envelope is applied:
 * either the fixed interval, or (when a scheduled refresh time is configured)
 * the number of seconds until that wall-clock time next occurs.
 */
function desiredSleepSeconds(schedule: RefreshSchedule): number {
  if (schedule.enabled) {
    return secondsUntilNextScheduledTime(schedule.times, schedule.timezone);
  }
  return config.defaultSleepSeconds;
}

/**
 * Resolves the effective refresh schedule for a frame: its own `refresh_schedule`
 * override (a JSON-encoded `RefreshSchedule`) when set, falling back to the global
 * `config.refreshSchedule` when the frame has none, or when the stored JSON is
 * malformed (defensive, matching the parsing style in config.ts's `reloadConfigFromDb`).
 */
function resolveFrameSchedule(raw: string | null | undefined): RefreshSchedule {
  if (!raw) return config.refreshSchedule;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.times)) {
      const times = parsed.times.filter((t: unknown) => typeof t === "string");
      return {
        enabled: Boolean(parsed.enabled),
        times: times.length > 0 ? times : config.refreshSchedule.times,
        timezone: typeof parsed.timezone === "string" ? parsed.timezone : config.refreshSchedule.timezone
      };
    }
    return config.refreshSchedule;
  } catch {
    return config.refreshSchedule;
  }
}

/**
 * Evaluates whether a frame requires an immediate forced refresh cycle
 * to satisfy the 24-Hour Physical E-Paper Particle Safety Rule.
 */
export function evaluateFrameWatchdog(frameId: string): WatchdogEvaluation {
  const db = getDb();
  const frame = db.prepare("SELECT last_refresh_at, refresh_schedule FROM frames WHERE id = ?").get(frameId) as
    | { last_refresh_at?: number; refresh_schedule?: string | null }
    | undefined;

  const schedule = resolveFrameSchedule(frame?.refresh_schedule);
  const now = Date.now();
  const maxIntervalMs = config.watchdogHours * 3600 * 1000; // 24 hours
  const warnThresholdMs = (config.watchdogHours - 2) * 3600 * 1000; // 22 hours

  if (!frame || !frame.last_refresh_at) {
    return {
      shouldForceRefresh: true,
      recommendedSleepSeconds: desiredSleepSeconds(schedule)
    };
  }

  const elapsedMs = now - frame.last_refresh_at;

  if (elapsedMs >= warnThresholdMs) {
    // We are approaching or past the 24-hour mark; force an update now
    return {
      shouldForceRefresh: true,
      recommendedSleepSeconds: desiredSleepSeconds(schedule)
    };
  }

  // Calculate remaining seconds to guarantee a refresh before 24 hours
  const remainingSeconds = Math.max(
    180, // Minimum 180s refresh interval per panel datasheet
    Math.floor((maxIntervalMs - elapsedMs) / 1000)
  );

  const sleepSeconds = Math.min(desiredSleepSeconds(schedule), remainingSeconds);

  return {
    shouldForceRefresh: false,
    recommendedSleepSeconds: sleepSeconds
  };
}

/**
 * Records when this frame is expected to next check in, based on the X-Sleep-Seconds
 * value it was just told to sleep for. Pass `null` for an indefinite sleep (Storage Mode).
 */
export function recordNextExpectedRefresh(frameId: string, sleepSeconds: number | null): void {
  const db = getDb();
  const nextAt = sleepSeconds === null ? null : Date.now() + sleepSeconds * 1000;
  db.prepare("UPDATE frames SET next_expected_refresh_at = ? WHERE id = ?").run(nextAt, frameId);
}

/**
 * Records the image ID the frame confirmed it successfully displayed (via /frame/ack).
 */
export function recordCurrentImage(frameId: string, imageId: string): void {
  const db = getDb();
  db.prepare("UPDATE frames SET current_image_id = ? WHERE id = ?").run(imageId, frameId);
}

/**
 * Updates frame check-in and refresh timestamps.
 */
export function recordFrameActivity(
  frameId: string,
  batteryVoltage?: number,
  firmwareVersion?: string,
  didRefresh = false
): void {
  const db = getDb();
  const now = Date.now();

  const existing = db.prepare("SELECT id FROM frames WHERE id = ?").get(frameId);

  if (!existing) {
    db.prepare(`
      INSERT INTO frames (id, name, last_checkin_at, last_refresh_at, battery_voltage, firmware_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      frameId,
      `Frame-${frameId.slice(-4)}`,
      now,
      didRefresh ? now : null,
      batteryVoltage || null,
      firmwareVersion || null,
      now
    );
  } else {
    const v = batteryVoltage ?? null;
    const fw = firmwareVersion ?? null;
    if (didRefresh) {
      db.prepare(`
        UPDATE frames
        SET last_checkin_at = ?, last_refresh_at = ?, battery_voltage = COALESCE(?, battery_voltage), firmware_version = COALESCE(?, firmware_version)
        WHERE id = ?
      `).run(now, now, v, fw, frameId);
    } else {
      db.prepare(`
        UPDATE frames
        SET last_checkin_at = ?, battery_voltage = COALESCE(?, battery_voltage), firmware_version = COALESCE(?, firmware_version)
        WHERE id = ?
      `).run(now, v, fw, frameId);
    }
  }
}
