import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  dataDir: string;
  cacheDir: string;
  dbPath: string;
  frameToken: string;
  adminPassword: string;
  defaultSleepSeconds: number;
  watchdogHours: number;
  idleShuffleHours: number;
  epdWidth: number;
  epdHeight: number;
  immichHost: string;
  immichApiKey: string;
  immichAlbumId: string;
  googlePhotosShareUrl: string;
  googlePhotosClientId: string;
  googlePhotosClientSecret: string;
  googlePhotosRefreshToken: string;
  googlePhotosAlbumId: string;
  icloudSharedAlbumToken: string;
  frameOrientation: "portrait" | "portrait_180" | "landscape" | "landscape_270";
  fitMode: "matting" | "cover" | "rotate";
  epdoptimizeConfig: EpdOptimizeConfig;
  trustProxy: boolean;
  refreshSchedule: RefreshSchedule;
}

export interface RefreshSchedule {
  enabled: boolean;
  times: string[];     // One or more "HH:MM" 24-hour times, all interpreted in `timezone`
  timezone: string;    // IANA timezone, e.g. "America/Bogota"
}

export const DEFAULT_REFRESH_SCHEDULE: RefreshSchedule = {
  enabled: false,
  times: ["07:00"],
  timezone: "UTC"
};

export interface EpdOptimizeConfig {
  palette?: string;
  imageAdjustmentOptions?: {
    dynamicRangeCompression?: {
      mode: "display" | "auto" | "off";
      strength: number;
      lowPercentile: number;
      highPercentile: number;
    };
  };
  canvasDitherOptions?: {
    serpentine?: boolean;
    edgePreservation?: {
      enabled: boolean;
      strength: number;
    };
  };
  [key: string]: unknown;
}

export const DEFAULT_EPDOPTIMIZE_CONFIG: EpdOptimizeConfig = {
  palette: "aitjcizeSpectra6Palette",
  imageAdjustmentOptions: {
    dynamicRangeCompression: {
      mode: "display",
      strength: 0.7,
      lowPercentile: 0.01,
      highPercentile: 0.99
    }
  },
  canvasDitherOptions: {
    serpentine: true,
    edgePreservation: {
      enabled: true,
      strength: 0.65
    }
  }
};

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const cacheDir = path.join(dataDir, "cache");

export const config: AppConfig = {
  port: parseInt(process.env.PORT || "8080", 10),
  dataDir,
  cacheDir,
  dbPath: path.join(dataDir, "memories.sqlite"),
  frameToken: process.env.FRAME_TOKEN || "memories-frame-secure-token-12345",
  // No hardcoded default here: if ADMIN_PASSWORD isn't set in the environment, this stays
  // empty until database.ts's getDb() generates (or reloads) a persisted random password.
  adminPassword: process.env.ADMIN_PASSWORD || "",
  defaultSleepSeconds: parseInt(process.env.DEFAULT_SLEEP_SECONDS || "14400", 10), // 4 hours
  watchdogHours: parseInt(process.env.WATCHDOG_HOURS || "24", 10), // Max 24 hours without refresh
  idleShuffleHours: parseInt(process.env.IDLE_SHUFFLE_HOURS || "24", 10),
  epdWidth: 1200,
  epdHeight: 1600,
  immichHost: process.env.IMMICH_HOST || "",
  immichApiKey: process.env.IMMICH_API_KEY || "",
  immichAlbumId: process.env.IMMICH_ALBUM_ID || "",
  googlePhotosShareUrl: process.env.GOOGLE_PHOTOS_SHARE_URL || "",
  googlePhotosClientId: process.env.GOOGLE_PHOTOS_CLIENT_ID || "",
  googlePhotosClientSecret: process.env.GOOGLE_PHOTOS_CLIENT_SECRET || "",
  googlePhotosRefreshToken: process.env.GOOGLE_PHOTOS_REFRESH_TOKEN || "",
  googlePhotosAlbumId: process.env.GOOGLE_PHOTOS_ALBUM_ID || "",
  icloudSharedAlbumToken: process.env.ICLOUD_SHARED_ALBUM_TOKEN || "",
  frameOrientation: (process.env.FRAME_ORIENTATION as any) || "portrait_180",
  fitMode: (process.env.FIT_MODE as any) || "matting",
  epdoptimizeConfig: DEFAULT_EPDOPTIMIZE_CONFIG,
  // Only trust X-Forwarded-For/proxy headers when we know a reverse proxy (Cloudflare
  // Tunnel, Nginx, etc.) actually sits in front of this app and sets them. Defaults to
  // false so client-supplied headers can't be used to spoof IPs (e.g. to bypass the
  // login rate limiter) on a bare/homelab deployment.
  trustProxy: process.env.TRUST_PROXY === "1",
  refreshSchedule: DEFAULT_REFRESH_SCHEDULE
};

// Whether the operator explicitly set ADMIN_PASSWORD in the environment. When false,
// database.ts is responsible for generating (or re-loading) a persisted random password
// and assigning it to config.adminPassword.
export const ADMIN_PASSWORD_ENV_SET = Boolean(process.env.ADMIN_PASSWORD);

export function reloadConfigFromDb(db: any) {
  try {
    const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      if (row.key === "google_photos_share_url") config.googlePhotosShareUrl = row.value;
      if (row.key === "google_photos_client_id") config.googlePhotosClientId = row.value;
      if (row.key === "google_photos_client_secret") config.googlePhotosClientSecret = row.value;
      if (row.key === "google_photos_refresh_token") config.googlePhotosRefreshToken = row.value;
      if (row.key === "google_photos_album_id") config.googlePhotosAlbumId = row.value;
      if (row.key === "immich_host") config.immichHost = row.value;
      if (row.key === "immich_api_key") config.immichApiKey = row.value;
      if (row.key === "immich_album_id") config.immichAlbumId = row.value;
      if (row.key === "icloud_shared_album_token") config.icloudSharedAlbumToken = row.value;
      if (row.key === "frame_orientation" && (row.value === "portrait" || row.value === "portrait_180" || row.value === "landscape" || row.value === "landscape_270")) {
        config.frameOrientation = row.value as any;
      }
      if (row.key === "fit_mode" && (row.value === "matting" || row.value === "cover" || row.value === "rotate")) {
        config.fitMode = row.value as any;
      }
      if (row.key === "epdoptimize_config") {
        try {
          config.epdoptimizeConfig = JSON.parse(row.value);
        } catch {
          // Ignore malformed stored config; keep previous value
        }
      }
      if (row.key === "refresh_schedule") {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed && typeof parsed === "object") {
            // Migrate the old single-`time` shape to `times: string[]` transparently.
            let times: string[] = DEFAULT_REFRESH_SCHEDULE.times;
            if (Array.isArray(parsed.times) && parsed.times.length > 0) {
              times = parsed.times.filter((t: unknown) => typeof t === "string");
            } else if (typeof parsed.time === "string") {
              times = [parsed.time];
            }
            config.refreshSchedule = {
              enabled: Boolean(parsed.enabled),
              times: times.length > 0 ? times : DEFAULT_REFRESH_SCHEDULE.times,
              timezone: typeof parsed.timezone === "string" ? parsed.timezone : DEFAULT_REFRESH_SCHEDULE.timezone
            };
          }
        } catch {
          // Ignore malformed stored config; keep previous value
        }
      }
    }
  } catch (err) {
    // Database may be initializing
  }
}
