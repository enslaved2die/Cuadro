import { AlbumAdapter, RemotePhoto } from "./base.js";
import { config } from "../config.js";

/**
 * Per-`album_sources` row override config, matching that table's `config_json` shape for
 * type 'immich'. See GooglePhotosSourceConfig for the same phase-1-only caveat: the class
 * is CAPABLE of taking an override, but sync-scheduler.ts's current no-arg instantiation
 * doesn't pass one yet (Phase 2 work).
 */
export interface ImmichSourceConfig {
  host?: string;
  apiKey?: string;
  albumId?: string;
}

export class ImmichAdapter implements AlbumAdapter {
  name = "immich";
  private readonly override?: ImmichSourceConfig;

  constructor(override?: ImmichSourceConfig) {
    this.override = override;
  }

  private get host(): string {
    return this.override?.host ?? config.immichHost;
  }
  private get apiKey(): string {
    return this.override?.apiKey ?? config.immichApiKey;
  }
  private get albumId(): string {
    return this.override?.albumId ?? config.immichAlbumId;
  }

  isEnabled(): boolean {
    return Boolean(this.host && this.apiKey && this.albumId);
  }

  async downloadByUrl(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { "x-api-key": this.apiKey } });
    if (!res.ok) {
      throw new Error(`Failed to download Immich asset: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async pollNewPhotos(since?: Date): Promise<RemotePhoto[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const host = this.host.replace(/\/+$/, "");
    const url = `${host}/api/albums/${this.albumId}`;

    const res = await fetch(url, {
      headers: {
        "x-api-key": this.apiKey,
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`Immich API error: ${res.status} ${res.statusText}`);
    }

    const albumData = (await res.json()) as {
      assets?: Array<{
        id: string;
        fileCreatedAt: string;
        type: string;
      }>;
    };

    const assets = albumData.assets || [];
    const photos: RemotePhoto[] = [];

    for (const asset of assets) {
      if (asset.type !== "IMAGE") continue;

      const createdAt = new Date(asset.fileCreatedAt);
      if (since && createdAt <= since) continue;

      const downloadUrl = `${host}/api/assets/${asset.id}/original`;

      photos.push({
        id: `immich_${asset.id}`,
        source: "immich",
        sourceId: asset.id,
        originalUrl: downloadUrl,
        // Immich's dedicated thumbnail endpoint - small JPEG, cheap to fetch for the admin
        // Library gallery without pulling the full original.
        previewUrl: `${host}/api/assets/${asset.id}/thumbnail`,
        createdAt,
        downloadBuffer: async () => {
          const dlRes = await fetch(downloadUrl, {
            headers: {
              "x-api-key": this.apiKey
            }
          });
          if (!dlRes.ok) {
            throw new Error(`Failed to download Immich asset ${asset.id}: ${dlRes.status}`);
          }
          const arrayBuf = await dlRes.arrayBuffer();
          return Buffer.from(arrayBuf);
        }
      });
    }

    return photos;
  }
}
