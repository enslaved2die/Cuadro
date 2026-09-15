export interface RemotePhoto {
  id: string;
  source: "immich" | "google_photos" | "icloud" | "upload";
  sourceId: string;
  originalUrl: string;
  // Small (~320px) preview URL for the admin Library gallery, when the provider offers a
  // cheap bounded-size variant. Falls back to downloading (and shrinking) the full original
  // for its preview when absent - see sync-scheduler.ts#registerPhotoPreview.
  previewUrl?: string;
  createdAt: Date;
  downloadBuffer: () => Promise<Buffer>;
}

export interface AlbumAdapter {
  name: string;
  isEnabled: () => boolean;
  pollNewPhotos: (since?: Date) => Promise<RemotePhoto[]>;
  // Downloads a full-resolution asset by URL (an originalUrl captured during a previous
  // pollNewPhotos call), applying whatever auth this adapter's downloads need (e.g. Immich's
  // x-api-key header). Used to lazily fetch a photo's real bytes the first time it's actually
  // about to be shown, rather than eagerly downloading every photo in an album at sync time.
  downloadByUrl: (url: string) => Promise<Buffer>;
}
