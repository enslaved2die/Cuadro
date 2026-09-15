import { getDb } from "../db/database.js";

export interface PhotoRecord {
  id: string;
  source: string;
  source_id?: string;
  original_url: string;
  file_path: string;
  bin_path: string;
  width: number;
  height: number;
  uploaded_at: number;
  shown_count: number;
  last_shown_at?: number;
  is_active: number;
  downloaded_at?: number | null;
}

// Storage mode is per-frame (see `frames.storage_mode`), not a global setting - each frame's
// own row is the source of truth (see api/frame.ts's GET /next and api/album-sources.ts's
// PATCH /frames/:id "storageMode" field).
export function isFrameStorageModeEnabled(frameId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT storage_mode FROM frames WHERE id = ?").get(frameId) as
    | { storage_mode: number | null }
    | undefined;
  return Boolean(row?.storage_mode);
}

export function setFrameStorageMode(frameId: string, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE frames SET storage_mode = ? WHERE id = ?").run(enabled ? 1 : 0, frameId);
}

export function enqueuePhoto(photoId: string, priority = 10): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO queue (photo_id, priority, scheduled_at, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(photoId, priority, now, now);
}

// Shared by getNextPhoto and peekNextPhoto: finds whichever photo would currently be served
// to a frame (priority queue first, then least-recently-shown idle shuffle), without
// mutating anything. See getNextPhoto's own doc comment for the album-assignment filter
// semantics this applies.
function findNextCandidate(frameId: string): { record: PhotoRecord; queueId?: number } | null {
  const db = getDb();

  const assignments = db
    .prepare("SELECT album_source_id FROM frame_album_assignments WHERE frame_id = ?")
    .all(frameId) as Array<{ album_source_id: string }>;
  const albumSourceIds = assignments.map((a) => a.album_source_id);
  const hasAssignments = albumSourceIds.length > 0;
  const sourceFilterSql = hasAssignments
    ? `AND p.album_source_id IN (${albumSourceIds.map(() => "?").join(",")})`
    : "";
  const sourceFilterSqlUnaliased = hasAssignments
    ? `AND album_source_id IN (${albumSourceIds.map(() => "?").join(",")})`
    : "";

  // 1. Check priority queue for newly queued photos
  const queued = db
    .prepare(`
      SELECT q.id as queue_id, p.*
      FROM queue q
      JOIN photos p ON q.photo_id = p.id
      WHERE q.status = 'pending' AND p.is_active = 1
      ${sourceFilterSql}
      ORDER BY q.priority DESC, q.scheduled_at ASC
      LIMIT 1
    `)
    .get(...(hasAssignments ? albumSourceIds : [])) as (PhotoRecord & { queue_id: number }) | undefined;

  if (queued) {
    const { queue_id, ...record } = queued;
    return { record, queueId: queue_id };
  }

  // 2. Idle Shuffle: pick least-recently-shown active photo
  const candidate = db
    .prepare(`
      SELECT *
      FROM photos
      WHERE is_active = 1
      ${sourceFilterSqlUnaliased}
      ORDER BY last_shown_at ASC, RANDOM()
      LIMIT 1
    `)
    .get(...(hasAssignments ? albumSourceIds : [])) as PhotoRecord | undefined;

  return candidate ? { record: candidate } : null;
}

/**
 * Returns the next photo to serve to a given frame, and marks it served (moves the queue
 * entry to 'served', bumps shown_count/last_shown_at). Call this only when actually about to
 * serve a photo to a real frame - for a read-only preview of what's coming up next (e.g. the
 * dashboard's "next sync" thumbnail), use peekNextPhoto instead.
 *
 * If `frameId` has one or more rows in `frame_album_assignments`, eligible photos are
 * additionally restricted to those whose `album_source_id` is one of the assigned
 * sources. If the frame has NO recorded assignment (the default for every frame that
 * existed before the multi-frame migration, and for any frame not yet explicitly
 * configured), no filter is applied at all - the frame sees the full active library,
 * exactly as it did before per-frame album assignments existed. This is a deliberate
 * backward-compatible fallback, not a bug.
 */
export function getNextPhoto(frameId: string): PhotoRecord | null {
  const db = getDb();
  const found = findNextCandidate(frameId);
  if (!found) return null;

  if (found.queueId !== undefined) {
    db.prepare("UPDATE queue SET status = 'served' WHERE id = ?").run(found.queueId);
  }
  db.prepare("UPDATE photos SET shown_count = shown_count + 1, last_shown_at = ? WHERE id = ?").run(
    Date.now(),
    found.record.id
  );
  return found.record;
}

/**
 * Read-only preview of whichever photo findNextCandidate would currently pick for this frame
 * - same selection logic as getNextPhoto, but does not mark anything served or touch
 * shown_count/last_shown_at. Used by the dashboard to show "what's up next" without disturbing
 * the real serving order.
 */
export function peekNextPhoto(frameId: string): PhotoRecord | null {
  return findNextCandidate(frameId)?.record ?? null;
}
