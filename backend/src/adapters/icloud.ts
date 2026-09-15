import { AlbumAdapter, RemotePhoto } from "./base.js";
import { config } from "../config.js";

/**
 * Extract the iCloud Shared Album token from either a raw token or a full
 * share URL. Apple has used (at least) two different URL shapes over the
 * years:
 *   - https://www.icloud.com/sharedalbum/#B0xxxxxxxxxxxxx   (legacy, token in the hash fragment)
 *   - https://share.icloud.com/photos/xxxxxxxxxxxxxxxxxxxxx (current, token is the last path segment)
 * Users often paste the full URL into the settings field, so we normalize
 * it down to just the token here.
 */
export function extractICloudToken(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";

  // Legacy format: token lives after a "#" fragment.
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex !== -1) {
    return trimmed.slice(hashIndex + 1).trim();
  }

  // Current format (and any other URL): take the last non-empty path segment.
  if (trimmed.includes("/")) {
    const url = trimmed.split(/[?#]/)[0]; // drop query/fragment if any
    const segments = url.split("/").filter(Boolean);
    return segments[segments.length - 1] || "";
  }

  // Already a bare token.
  return trimmed;
}

interface AppleHostRedirect {
  "X-Apple-MMe-Host"?: string;
}

/**
 * POST to an iCloud Shared Stream endpoint, transparently following Apple's
 * "host reassignment" mechanism: the partition host guessed up front
 * (or the default `sharedstreams.icloud.com`) is frequently wrong, and Apple
 * signals the correct one via an HTTP 330 (occasionally 400) response whose
 * JSON body is `{"X-Apple-MMe-Host": "pNN-sharedstreams.icloud.com"}`. A
 * correct client must retry the exact same request against that host.
 */
async function postWithHostRedirect(
  host: string,
  path: string,
  body: unknown
): Promise<{ res: Response; host: string }> {
  const doPost = (h: string) =>
    fetch(`https://${h}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  let res = await doPost(host);
  let currentHost = host;

  // Apple signals the correct partition host with a 330 (sometimes 400)
  // whose body carries X-Apple-MMe-Host. Follow it once.
  if (res.status === 330 || res.status === 400) {
    const cloned = res.clone();
    let redirect: AppleHostRedirect | null = null;
    try {
      redirect = (await cloned.json()) as AppleHostRedirect;
    } catch {
      redirect = null;
    }

    const newHost = redirect?.["X-Apple-MMe-Host"];
    if (newHost && newHost !== currentHost) {
      res = await doPost(newHost);
      currentHost = newHost;
    }
  }

  return { res, host: currentHost };
}

/**
 * Per-`album_sources` row override config, matching that table's `config_json` shape for
 * type 'icloud'. See GooglePhotosSourceConfig for the same phase-1-only caveat: the class
 * is CAPABLE of taking an override, but sync-scheduler.ts's current no-arg instantiation
 * doesn't pass one yet (Phase 2 work).
 */
export interface ICloudSourceConfig {
  token?: string;
}

export class ICloudAdapter implements AlbumAdapter {
  name = "icloud";
  private readonly override?: ICloudSourceConfig;

  constructor(override?: ICloudSourceConfig) {
    this.override = override;
  }

  private get token(): string {
    return this.override?.token ?? config.icloudSharedAlbumToken;
  }

  isEnabled(): boolean {
    return Boolean(this.token);
  }

  async downloadByUrl(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download iCloud asset: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async pollNewPhotos(since?: Date): Promise<RemotePhoto[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const token = extractICloudToken(this.token);
    if (!token) {
      return [];
    }

    // Don't guess a partition up front — start at the unprefixed host and
    // let postWithHostRedirect follow Apple's X-Apple-MMe-Host reassignment
    // to the correct pNN-sharedstreams.icloud.com host.
    const { res: metaRes, host } = await postWithHostRedirect(
      "sharedstreams.icloud.com",
      `/${token}/sharedstreams/webstream`,
      { streamCtag: null }
    );

    if (!metaRes.ok) {
      throw new Error(`iCloud Shared Stream request failed: ${metaRes.status}`);
    }

    const metaData = (await metaRes.json()) as {
      photos?: Array<{
        photoGuid: string;
        dateCreated: string;
        derivatives?: Record<string, { checksum: string; fileSize?: string }>;
      }>;
    };

    const streamPhotos = metaData.photos || [];
    if (streamPhotos.length === 0) return [];

    const photoGuids = streamPhotos.map((p) => p.photoGuid);

    // Request actual asset URLs. Reuse the host we were just redirected to —
    // it's the same partition for both endpoints — but still fall back to
    // following a fresh redirect in case Apple reassigns again.
    const { res: urlRes } = await postWithHostRedirect(
      host,
      `/${token}/sharedstreams/webasseturls`,
      { photoGuids }
    );

    if (!urlRes.ok) {
      throw new Error(`iCloud webasseturls request failed: ${urlRes.status}`);
    }

    const assetData = (await urlRes.json()) as {
      items?: Record<string, { url_path: string }>;
      locations?: Record<string, { hosts: string[]; scheme: string }>;
    };

    const photos: RemotePhoto[] = [];

    for (const p of streamPhotos) {
      const createdAt = new Date(p.dateCreated);
      if (since && createdAt <= since) continue;

      // Select highest resolution derivative
      const derivatives = p.derivatives || {};
      const highestResKey = Object.keys(derivatives).sort().pop();
      if (!highestResKey) continue;

      const checksum = derivatives[highestResKey].checksum;
      const item = assetData.items?.[checksum];
      if (!item) continue;

      // Pick the first available CDN location host
      const locationKey = Object.keys(assetData.locations || {})[0];
      const location = assetData.locations?.[locationKey];
      if (!location || !location.hosts || location.hosts.length === 0) continue;

      const assetHost = location.hosts[0];
      const scheme = location.scheme || "https";
      const fullUrl = `${scheme}://${assetHost}${item.url_path}`;

      // Smallest available derivative, if there's more than one size - a cheap preview for
      // the admin Library gallery without downloading the full-resolution original.
      let previewUrl: string | undefined;
      const derivativeKeys = Object.keys(derivatives).sort();
      const smallestResKey = derivativeKeys[0];
      if (smallestResKey && smallestResKey !== highestResKey) {
        const smallChecksum = derivatives[smallestResKey].checksum;
        const smallItem = assetData.items?.[smallChecksum];
        if (smallItem) {
          previewUrl = `${scheme}://${assetHost}${smallItem.url_path}`;
        }
      }

      photos.push({
        id: `icloud_${p.photoGuid}`,
        source: "icloud",
        sourceId: p.photoGuid,
        originalUrl: fullUrl,
        previewUrl,
        createdAt,
        downloadBuffer: async () => {
          const dlRes = await fetch(fullUrl);
          if (!dlRes.ok) {
            throw new Error(`Failed to download iCloud photo ${p.photoGuid}: ${dlRes.status}`);
          }
          const arrayBuf = await dlRes.arrayBuffer();
          return Buffer.from(arrayBuf);
        }
      });
    }

    return photos;
  }
}
