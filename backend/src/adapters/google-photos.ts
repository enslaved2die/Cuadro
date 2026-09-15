import crypto from "node:crypto";
import { AlbumAdapter, RemotePhoto } from "./base.js";
import { config } from "../config.js";

/**
 * Per-`album_sources` row override config, matching that table's `config_json` shape for
 * type 'google_photos'. Phase 1 only makes the adapter CAPABLE of taking this (constructed
 * with an override, every field it reads falls back to the global `config` singleton for
 * any field left unset) - sync-scheduler.ts's fixed 3-adapter, no-arg instantiation is out
 * of scope for this phase and is wired up to actually pass these in Phase 2.
 */
export interface GooglePhotosSourceConfig {
  shareUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  albumId?: string;
}

export class GooglePhotosAdapter implements AlbumAdapter {
  name = "google_photos";
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly override?: GooglePhotosSourceConfig;

  constructor(override?: GooglePhotosSourceConfig) {
    this.override = override;
  }

  private get shareUrl(): string {
    return this.override?.shareUrl ?? config.googlePhotosShareUrl;
  }
  private get clientId(): string {
    return this.override?.clientId ?? config.googlePhotosClientId;
  }
  private get clientSecret(): string {
    return this.override?.clientSecret ?? config.googlePhotosClientSecret;
  }
  private get refreshToken(): string {
    return this.override?.refreshToken ?? config.googlePhotosRefreshToken;
  }
  private get albumId(): string {
    return this.override?.albumId ?? config.googlePhotosAlbumId;
  }

  isEnabled(): boolean {
    return Boolean(
      this.shareUrl ||
      (this.clientId &&
       this.clientSecret &&
       this.refreshToken &&
       this.albumId)
    );
  }

  async downloadByUrl(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      throw new Error(`Failed to download Google Photos asset: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async pollNewPhotos(since?: Date): Promise<RemotePhoto[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // If public share link is provided, use the zero-auth public link parser!
    if (this.shareUrl) {
      return this.pollPublicSharedAlbum(this.shareUrl, since);
    }

    // Fall back to OAuth 2.0 API if configured
    return this.pollOAuthAlbum(since);
  }

  /**
   * Scrapes public Google Photos shared albums (e.g. https://photos.app.goo.gl/...)
   * Zero Google Cloud project, zero OAuth, zero API keys required!
   */
  private async pollPublicSharedAlbum(shareUrl: string, since?: Date): Promise<RemotePhoto[]> {
    console.log(`[GOOGLE PHOTOS] Fetching public shared album: ${shareUrl}...`);

    let targetUrl = shareUrl.trim();
    if (!targetUrl.startsWith("http")) {
      targetUrl = `https://${targetUrl}`;
    }

    const res = await fetch(targetUrl, {
      redirect: "follow"
    });

    if (!res.ok) {
      throw new Error(`Google Photos album fetch failed: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const photos: RemotePhoto[] = [];
    const seenUrls = new Set<string>();

    // Google Photos shared album items always match https://lh3.googleusercontent.com/pw/<photo_key>
    const pwRegex = /https:\/\/lh3\.googleusercontent\.com\/pw\/([a-zA-Z0-9_\-]+)/g;
    const matches = [...html.matchAll(pwRegex)];

    for (const m of matches) {
      const photoKey = m[1];
      if (!seenUrls.has(photoKey)) {
        seenUrls.add(photoKey);
        // "=d" requests the original, full-resolution file (with EXIF intact) instead of a
        // small default preview or a bounded/cropped size variant.
        const downloadUrl = `https://lh3.googleusercontent.com/pw/${photoKey}=d`;

        photos.push({
          id: `gphoto_${photoKey.slice(0, 24)}`,
          source: "google_photos",
          sourceId: photoKey,
          originalUrl: downloadUrl,
          // "=w320" requests a small bounded-width preview instead of the full original -
          // cheap to fetch for the admin Library gallery without downloading the whole photo.
          previewUrl: `https://lh3.googleusercontent.com/pw/${photoKey}=w320`,
          createdAt: new Date(),
          downloadBuffer: async () => {
            const dlRes = await fetch(downloadUrl, {
              headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (!dlRes.ok) {
              throw new Error(`Failed to download photo ${photoKey}: ${dlRes.status}`);
            }
            const arrayBuf = await dlRes.arrayBuffer();
            return Buffer.from(arrayBuf);
          }
        });
      }
    }

    console.log(`[GOOGLE PHOTOS] Discovered ${photos.length} photos in public album.`);
    return photos;
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.cachedAccessToken;
    }

    const tokenUrl = "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token"
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (!res.ok) {
      throw new Error(`Google OAuth token refresh failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedAccessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.cachedAccessToken;
  }

  private async pollOAuthAlbum(since?: Date): Promise<RemotePhoto[]> {
    const token = await this.getAccessToken();
    const searchUrl = "https://photoslibrary.googleapis.com/v1/mediaItems:search";

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        albumId: this.albumId,
        pageSize: 50
      })
    });

    if (!res.ok) {
      throw new Error(`Google Photos API search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      mediaItems?: Array<{
        id: string;
        baseUrl: string;
        mediaMetadata?: { creationTime?: string };
        mimeType?: string;
      }>;
    };

    const items = data.mediaItems || [];
    const photos: RemotePhoto[] = [];

    for (const item of items) {
      if (item.mimeType && !item.mimeType.startsWith("image/")) continue;

      const createdAt = item.mediaMetadata?.creationTime
        ? new Date(item.mediaMetadata.creationTime)
        : new Date();

      if (since && createdAt <= since) continue;

      // "=d" requests the original, full-resolution download from the Library API
      // (preserves EXIF); the pipeline's own sharp resize handles any input size.
      const downloadUrl = `${item.baseUrl}=d`;

      photos.push({
        id: `gphoto_${item.id}`,
        source: "google_photos",
        sourceId: item.id,
        originalUrl: downloadUrl,
        previewUrl: `${item.baseUrl}=w320`,
        createdAt,
        downloadBuffer: async () => {
          const dlRes = await fetch(downloadUrl);
          if (!dlRes.ok) {
            throw new Error(`Failed to download Google Photo ${item.id}: ${dlRes.status}`);
          }
          const arrayBuf = await dlRes.arrayBuffer();
          return Buffer.from(arrayBuf);
        }
      });
    }

    return photos;
  }
}
