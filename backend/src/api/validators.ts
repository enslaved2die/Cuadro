import { EpdOptimizeConfig } from "../config.js";
import { isValidScheduleTime, isValidTimezone } from "../services/schedule.js";
import { RefreshSchedule } from "../config.js";

/**
 * Shared validation/formatting helpers used by both the global /settings endpoint
 * (admin.ts) and the per-source / per-frame endpoints (album-sources.ts), so the two
 * surfaces can't silently drift apart on what counts as a valid value.
 */

export const SECRET_MASK = "••••••••";

/** Masks a secret value the same way the existing /settings endpoint does: present -> mask, absent -> "". */
export function maskSecret(value: string | undefined | null): string {
  return value ? SECRET_MASK : "";
}

export const FRAME_ORIENTATIONS = ["portrait", "portrait_180", "landscape", "landscape_270"] as const;
export type FrameOrientationValue = (typeof FRAME_ORIENTATIONS)[number];

export function isValidFrameOrientation(value: unknown): value is FrameOrientationValue {
  return typeof value === "string" && (FRAME_ORIENTATIONS as readonly string[]).includes(value);
}

export const FIT_MODES = ["matting", "cover", "rotate"] as const;
export type FitModeValue = (typeof FIT_MODES)[number];

export function isValidFitMode(value: unknown): value is FitModeValue {
  return typeof value === "string" && (FIT_MODES as readonly string[]).includes(value);
}

/**
 * Validates (and normalizes) a candidate epdoptimizeConfig value. Accepts either an
 * already-parsed object or a JSON string (the settings UI has historically sent both).
 * Mirrors the inline validation that used to live only in admin.ts's POST /settings.
 */
export function validateEpdoptimizeConfig(input: unknown): { value?: EpdOptimizeConfig; error?: string } {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { error: "epdoptimizeConfig is not valid JSON." };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "epdoptimizeConfig must be a JSON object." };
  }
  return { value: parsed as EpdOptimizeConfig };
}

/**
 * Validates a candidate refreshSchedule object, accepting the same shapes the global
 * /settings endpoint does (including the legacy single-`time` string field). Returns a
 * normalized {enabled, times, timezone} object on success.
 */
export function validateRefreshSchedule(input: unknown): { value?: RefreshSchedule; error?: string } {
  const raw = input as any;
  const enabled = Boolean(raw?.enabled);
  const rawTimes: unknown[] = Array.isArray(raw?.times)
    ? raw.times
    : typeof raw?.time === "string"
    ? [raw.time]
    : [];
  const times = rawTimes.map((t) => String(t).trim()).filter((t) => t.length > 0);
  const timezone = String(raw?.timezone ?? "UTC").trim();

  if (enabled && times.length === 0) {
    return { error: "refreshSchedule.times must include at least one time." };
  }
  const invalidTime = times.find((t) => !isValidScheduleTime(t));
  if (enabled && invalidTime) {
    return { error: `refreshSchedule time "${invalidTime}" must be in HH:MM 24-hour format.` };
  }
  if (enabled && !isValidTimezone(timezone)) {
    return { error: `refreshSchedule.timezone "${timezone}" is not a recognized IANA timezone.` };
  }

  return { value: { enabled, times: times.length > 0 ? times : ["07:00"], timezone } };
}
