import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { albumSourcesRouter } from "../src/api/album-sources.js";
import { getDb } from "../src/db/database.js";
import { createSession } from "../src/api/auth.js";

/**
 * HTTP-level tests for the Phase 2+3 album-sources / per-frame-settings API
 * (src/api/album-sources.ts). Unlike admin-status.test.ts (which calls computeFrameState
 * directly), these actually exercise the Express router end-to-end - including
 * requireAdminAuth - since the whole point of this API is its request/response contract
 * for the frontend team.
 *
 * Uses the shared getDb() instance (same convention as multi-frame.test.ts's second and
 * third tests) rather than a fresh temp database, since these endpoints are only meaningful
 * against the real schema/migrations. Every row created here uses a crypto.randomUUID()-
 * prefixed id and is deleted in a `finally` block, so this can never leave stray data behind
 * in - or corrupt - a real dev database.
 */

let server: Server;
let baseUrl: string;
let authHeader: string;

test.before(async () => {
  // Force DB init (and the one-time migration) before starting the server.
  getDb();
  const sessionToken = createSession("127.0.0.1");
  authHeader = `Bearer ${sessionToken}`;

  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", albumSourcesRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1/admin`;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function authedFetch(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      ...(init?.headers || {})
    }
  });
}

test("Album Sources API: rejects requests with no admin auth", async () => {
  const res = await fetch(`${baseUrl}/album-sources`);
  assert.equal(res.status, 401);
});

test("Album Sources API: create / list / update / delete lifecycle", async (t) => {
  let createdId: string | undefined;

  try {
    await t.test("POST rejects an unknown type", async () => {
      const res = await authedFetch("/album-sources", {
        method: "POST",
        body: JSON.stringify({ name: "Bad", type: "dropbox", config: {} })
      });
      assert.equal(res.status, 400);
    });

    await t.test("POST rejects immich config missing required fields", async () => {
      const res = await authedFetch("/album-sources", {
        method: "POST",
        body: JSON.stringify({ name: "Incomplete Immich", type: "immich", config: { host: "https://x.example.com" } })
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /immich config requires/);
    });

    await t.test("POST creates a valid immich source", async () => {
      const res = await authedFetch("/album-sources", {
        method: "POST",
        body: JSON.stringify({
          name: `Test Immich ${crypto.randomUUID()}`,
          type: "immich",
          config: { host: "https://immich.example.com", apiKey: "super-secret-key", albumId: "album-123" },
          enabled: true
        })
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.status, "success");
      assert.equal(body.albumSource.type, "immich");
      assert.equal(body.albumSource.enabled, true);
      assert.equal(body.albumSource.config.host, "https://immich.example.com");
      assert.equal(body.albumSource.config.albumId, "album-123");
      // Secret masking on create response too.
      assert.equal(body.albumSource.config.apiKey, "••••••••");
      createdId = body.albumSource.id;
    });

    await t.test("GET list includes the created source, masked", async () => {
      const res = await authedFetch("/album-sources");
      assert.equal(res.status, 200);
      const body = await res.json();
      const found = body.albumSources.find((s: any) => s.id === createdId);
      assert.ok(found, "created source should appear in the list");
      assert.equal(found.config.apiKey, "••••••••");
    });

    await t.test("PATCH with the masked sentinel leaves the secret unchanged", async () => {
      const before = await (await authedFetch("/album-sources")).json();
      const beforeRow = before.albumSources.find((s: any) => s.id === createdId);
      assert.equal(beforeRow.config.apiKey, "••••••••");

      const res = await authedFetch(`/album-sources/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed Immich", config: { apiKey: "••••••••", albumId: "album-456" } })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.albumSource.name, "Renamed Immich");
      assert.equal(body.albumSource.config.albumId, "album-456");
      assert.equal(body.albumSource.config.apiKey, "••••••••");

      // Verify the *actual* stored secret was preserved (not overwritten with the mask
      // literal itself) by checking the raw DB row.
      const db = getDb();
      const row = db.prepare("SELECT config_json FROM album_sources WHERE id = ?").get(createdId) as any;
      const cfg = JSON.parse(row.config_json);
      assert.equal(cfg.apiKey, "super-secret-key");
      assert.equal(cfg.albumId, "album-456");
    });

    await t.test("PATCH can actually change the secret when a real value is sent", async () => {
      const res = await authedFetch(`/album-sources/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify({ config: { apiKey: "brand-new-key" } })
      });
      assert.equal(res.status, 200);

      const db = getDb();
      const row = db.prepare("SELECT config_json FROM album_sources WHERE id = ?").get(createdId) as any;
      assert.equal(JSON.parse(row.config_json).apiKey, "brand-new-key");
    });

    await t.test("PATCH on unknown id returns 404", async () => {
      const res = await authedFetch(`/album-sources/${crypto.randomUUID()}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Nope" })
      });
      assert.equal(res.status, 404);
    });

    await t.test("DELETE removes the source (and its assignments)", async () => {
      // Assign a frame to this source first, to prove the assignment row is cleaned up too.
      const db = getDb();
      const frameId = `test-frame-del-${crypto.randomUUID()}`;
      db.prepare("INSERT INTO frames (id, name, created_at) VALUES (?, ?, ?)").run(frameId, "Del Test Frame", Date.now());
      db.prepare("INSERT INTO frame_album_assignments (frame_id, album_source_id, created_at) VALUES (?, ?, ?)").run(
        frameId,
        createdId,
        Date.now()
      );

      try {
        const res = await authedFetch(`/album-sources/${createdId}`, { method: "DELETE" });
        assert.equal(res.status, 200);

        const sourceRow = db.prepare("SELECT * FROM album_sources WHERE id = ?").get(createdId);
        assert.equal(sourceRow, undefined);

        const assignmentRows = db
          .prepare("SELECT * FROM frame_album_assignments WHERE album_source_id = ?")
          .all(createdId);
        assert.equal(assignmentRows.length, 0, "assignment rows must be cleaned up on source delete");
      } finally {
        db.prepare("DELETE FROM frames WHERE id = ?").run(frameId);
      }
      createdId = undefined; // already deleted, don't try again in the outer finally
    });
  } finally {
    if (createdId) {
      const db = getDb();
      db.prepare("DELETE FROM frame_album_assignments WHERE album_source_id = ?").run(createdId);
      db.prepare("DELETE FROM album_sources WHERE id = ?").run(createdId);
    }
  }
});

test("Album Sources API: frame album-source assignment replace (PUT), including empty-array fallback", async () => {
  const db = getDb();
  const frameId = `test-frame-assign-${crypto.randomUUID()}`;
  const sourceAId = crypto.randomUUID();
  const sourceBId = crypto.randomUUID();
  const now = Date.now();

  db.prepare("INSERT INTO frames (id, name, created_at) VALUES (?, ?, ?)").run(frameId, "Assign Test Frame", now);
  db.prepare(
    "INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at) VALUES (?, 'Src A', 'icloud', '{}', 1, NULL, ?)"
  ).run(sourceAId, now);
  db.prepare(
    "INSERT INTO album_sources (id, name, type, config_json, enabled, last_synced_at, created_at) VALUES (?, 'Src B', 'icloud', '{}', 1, NULL, ?)"
  ).run(sourceBId, now);

  try {
    // GET on a frame with no assignments yet.
    const initial = await authedFetch(`/frames/${frameId}/album-sources`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()).albumSourceIds, []);

    // PUT rejects an unknown album source id.
    const badPut = await authedFetch(`/frames/${frameId}/album-sources`, {
      method: "PUT",
      body: JSON.stringify({ albumSourceIds: [crypto.randomUUID()] })
    });
    assert.equal(badPut.status, 400);

    // PUT assigns both sources.
    const putRes = await authedFetch(`/frames/${frameId}/album-sources`, {
      method: "PUT",
      body: JSON.stringify({ albumSourceIds: [sourceAId, sourceBId] })
    });
    assert.equal(putRes.status, 200);

    const afterPut = await (await authedFetch(`/frames/${frameId}/album-sources`)).json();
    assert.deepEqual(new Set(afterPut.albumSourceIds), new Set([sourceAId, sourceBId]));

    // PUT replaces with a single source.
    await authedFetch(`/frames/${frameId}/album-sources`, {
      method: "PUT",
      body: JSON.stringify({ albumSourceIds: [sourceAId] })
    });
    const afterReplace = await (await authedFetch(`/frames/${frameId}/album-sources`)).json();
    assert.deepEqual(afterReplace.albumSourceIds, [sourceAId]);

    // PUT with an empty array deletes all assignment rows for the frame (documented
    // fallback-to-whole-library behavior, see the comment above the route).
    const emptyPut = await authedFetch(`/frames/${frameId}/album-sources`, {
      method: "PUT",
      body: JSON.stringify({ albumSourceIds: [] })
    });
    assert.equal(emptyPut.status, 200);
    const rowsAfterEmpty = db
      .prepare("SELECT * FROM frame_album_assignments WHERE frame_id = ?")
      .all(frameId);
    assert.equal(rowsAfterEmpty.length, 0);

    // 404 for a nonexistent frame.
    const missingFrame = await authedFetch(`/frames/${crypto.randomUUID()}/album-sources`, {
      method: "PUT",
      body: JSON.stringify({ albumSourceIds: [] })
    });
    assert.equal(missingFrame.status, 404);
  } finally {
    db.prepare("DELETE FROM frame_album_assignments WHERE frame_id = ?").run(frameId);
    db.prepare("DELETE FROM album_sources WHERE id IN (?, ?)").run(sourceAId, sourceBId);
    db.prepare("DELETE FROM frames WHERE id = ?").run(frameId);
  }
});

test("Album Sources API: PATCH /frames/:id override validation", async () => {
  const db = getDb();
  const frameId = `test-frame-patch-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO frames (id, name, created_at) VALUES (?, ?, ?)").run(frameId, "Patch Test Frame", Date.now());

  try {
    // 404 for a nonexistent frame.
    const missing = await authedFetch(`/frames/${crypto.randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ fitMode: "cover" })
    });
    assert.equal(missing.status, 404);

    // Bad schedule shape (invalid time format) is rejected.
    const badSchedule = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ refreshSchedule: { enabled: true, times: ["25:99"], timezone: "UTC" } })
    });
    assert.equal(badSchedule.status, 400);

    // Bad timezone is rejected.
    const badTz = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ refreshSchedule: { enabled: true, times: ["07:00"], timezone: "Not/AZone" } })
    });
    assert.equal(badTz.status, 400);

    // Invalid frameOrientation/fitMode enums are rejected.
    const badOrientation = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ frameOrientation: "upside_down" })
    });
    assert.equal(badOrientation.status, 400);

    // Valid epdoptimizeConfig is accepted and stored.
    const validEpd = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ epdoptimizeConfig: { palette: "customPalette" } })
    });
    assert.equal(validEpd.status, 200);
    const validEpdBody = await validEpd.json();
    assert.deepEqual(validEpdBody.frame.epdoptimizeConfig, { palette: "customPalette" });

    // Non-object epdoptimizeConfig is rejected.
    const badEpd = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ epdoptimizeConfig: "not-an-object" })
    });
    assert.equal(badEpd.status, 400);

    // Valid fitMode + frameOrientation + refreshSchedule all set together.
    const validAll = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({
        fitMode: "cover",
        frameOrientation: "landscape",
        refreshSchedule: { enabled: true, times: ["06:30", "18:00"], timezone: "America/Chicago" }
      })
    });
    assert.equal(validAll.status, 200);
    const validAllBody = await validAll.json();
    assert.equal(validAllBody.frame.fitMode, "cover");
    assert.equal(validAllBody.frame.frameOrientation, "landscape");
    assert.deepEqual(validAllBody.frame.refreshSchedule, {
      enabled: true,
      times: ["06:30", "18:00"],
      timezone: "America/Chicago"
    });

    // Explicit null clears an override back to "inherit global default".
    const cleared = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ fitMode: null, frameOrientation: null, epdoptimizeConfig: null, refreshSchedule: null })
    });
    assert.equal(cleared.status, 200);
    const clearedBody = await cleared.json();
    assert.equal(clearedBody.frame.fitMode, null);
    assert.equal(clearedBody.frame.frameOrientation, null);
    assert.equal(clearedBody.frame.epdoptimizeConfig, null);
    assert.equal(clearedBody.frame.refreshSchedule, null);

    // Confirm the DB columns themselves are actually NULL, not the string "null".
    const row = db.prepare("SELECT * FROM frames WHERE id = ?").get(frameId) as any;
    assert.equal(row.fit_mode, null);
    assert.equal(row.frame_orientation, null);
    assert.equal(row.epdoptimize_config, null);
    assert.equal(row.refresh_schedule, null);

    // Omitted fields on a partial PATCH leave existing overrides untouched.
    await authedFetch(`/frames/${frameId}`, { method: "PATCH", body: JSON.stringify({ fitMode: "matting" }) });
    const partial = await authedFetch(`/frames/${frameId}`, {
      method: "PATCH",
      body: JSON.stringify({ frameOrientation: "portrait" })
    });
    const partialBody = await partial.json();
    assert.equal(partialBody.frame.fitMode, "matting", "fitMode set by the previous PATCH must survive an unrelated PATCH");
    assert.equal(partialBody.frame.frameOrientation, "portrait");
  } finally {
    db.prepare("DELETE FROM frames WHERE id = ?").run(frameId);
  }
});
