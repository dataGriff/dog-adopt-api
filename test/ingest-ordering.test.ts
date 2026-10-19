// Timestamp normalisation, out-of-order deliveries and claim-first
// idempotency: the guarantees behind ingest-snapshot.feature that a queue
// with at-least-once, unordered delivery relies on.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { canonicalJson, sha256Hex, type Problem } from '@dogadopt/contracts';
import { dogByExternalId, fakeQueue, found, ingest, ingestOk, insertDog, json, rescueByName, snapshot } from './helpers.js';
import type { RescueRow } from '../src/types.js';

let cardiff: RescueRow;
beforeEach(async () => {
  cardiff = await rescueByName('Cardiff Dogs Home');
});

const statusEvents = async (dogId: string) =>
  (await env.DB.prepare('SELECT status, effective_at FROM dog_status_events WHERE dog_id = ? ORDER BY id').bind(dogId).all<{ status: string; effective_at: string }>()).results;

describe('Timestamps are normalised at the boundary', () => {
  it('A capture with a UTC offset that is older than the last sighting does not withdraw the dog', async () => {
    const max = await insertDog(cardiff, { name: 'Max', externalId: 'max-7', since: new Date('2026-10-19T09:30:00.000Z') });
    // 10:00+01:00 is 09:00Z: older than 09:30Z, however it compares as a string.
    const result = await ingestOk(cardiff.id, snapshot([], { capturedAt: '2026-10-19T10:00:00+01:00' }));
    expect(result.counts.withdrawn).toBe(0);
    expect(result.capturedAt).toBe('2026-10-19T09:00:00.000Z');
    const row = await dogByExternalId(cardiff.id, 'max-7');
    expect(row.status).toBe('available');
    expect(row.last_seen_at).toBe('2026-10-19T09:30:00.000Z');
    void max;
  });

  it('A capture with a UTC offset is stored as a Z timestamp', async () => {
    const result = await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')], { capturedAt: '2026-10-19T10:00:00+01:00' }));
    const row = await dogByExternalId(cardiff.id, 'bella-2');
    expect(row.first_seen_at).toBe('2026-10-19T09:00:00.000Z');
    expect(row.last_seen_at).toBe('2026-10-19T09:00:00.000Z');
    expect(result.capturedAt).toBe('2026-10-19T09:00:00.000Z');
    expect(await statusEvents(row.id)).toEqual([{ status: 'available', effective_at: '2026-10-19T09:00:00.000Z' }]);
  });
});

describe('Out-of-order snapshots never regress a dog', () => {
  it('An older snapshot delivered after a newer one leaves the dog as the newer one set it', async () => {
    const newer = snapshot([found('Maximus', 'max-7', { status: 'reserved' })], { capturedAt: '2026-10-19T12:00:00.000Z' });
    const older = snapshot([found('Max', 'max-7')], { capturedAt: '2026-10-19T09:00:00.000Z' });
    await ingestOk(cardiff.id, newer);
    const queue = fakeQueue();
    const result = await ingestOk(cardiff.id, older, { queue });
    expect(result.counts).toMatchObject({ created: 0, updated: 0, unchanged: 1, withdrawn: 0 });
    const row = await dogByExternalId(cardiff.id, 'max-7');
    expect(row.name).toBe('Maximus');
    expect(row.status).toBe('reserved');
    expect(row.last_seen_at).toBe('2026-10-19T12:00:00.000Z');
    expect((await statusEvents(row.id)).map((e) => e.status)).toEqual(['reserved']);
    expect(queue.sent).toEqual([]);
  });

  it('An older snapshot delivered after a withdrawal does not re-list the dog', async () => {
    await ingestOk(cardiff.id, snapshot([found('Max', 'max-7')], { capturedAt: '2026-10-19T08:00:00.000Z' }));
    await ingestOk(cardiff.id, snapshot([], { capturedAt: '2026-10-19T09:00:00.000Z' }));
    expect((await dogByExternalId(cardiff.id, 'max-7')).status).toBe('withdrawn');
    const queue = fakeQueue();
    const result = await ingestOk(cardiff.id, snapshot([found('Max', 'max-7')], { capturedAt: '2026-10-19T08:30:00.000Z' }), { queue });
    expect(result.counts).toMatchObject({ updated: 0, unchanged: 1 });
    expect((await dogByExternalId(cardiff.id, 'max-7')).status).toBe('withdrawn');
    expect(queue.sent).toEqual([]);
  });
});

describe('Idempotency-Key is claimed before any dog is written', () => {
  it('Two sequential posts with the same key return identical results and one set of status events', async () => {
    const body = snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')]);
    const first = await ingestOk(cardiff.id, body, { key: 'claim-key-1' });
    const second = await ingestOk(cardiff.id, body, { key: 'claim-key-1' });
    expect(second).toEqual(first);
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM dog_status_events').first<{ n: number }>();
    expect(events?.n).toBe(2);
    const rows = await env.DB.prepare('SELECT status FROM snapshots').all<{ status: string }>();
    expect(rows.results).toEqual([{ status: 'done' }]);
  });

  it('A post whose previous attempt is recorded as failed is re-processed', async () => {
    const body = snapshot([found('Bella', 'bella-2')]);
    const parsed = { ...body, capturedAt: new Date(body.capturedAt).toISOString() };
    const hash = await sha256Hex(canonicalJson({ rescueId: cardiff.id, snapshot: { ...parsed, dogs: parsed.dogs.map((d) => ({ ...d, status: 'available', goodWithKids: null, goodWithDogs: null, goodWithCats: null, profileUrl: null, imageUrl: null, birthYear: null, birthMonth: null, birthDay: null, rescueSinceDate: null })) } }));
    await env.DB.prepare(`INSERT INTO snapshots (id, rescue_id, idempotency_key, body_hash, captured_at, processed_at, adapter, mode, complete, status, result) VALUES (?, ?, 'failed-key', ?, ?, ?, 'cardiff-dogs-home', 'fixture', 1, 'failed', NULL)`)
      .bind(crypto.randomUUID(), cardiff.id, hash, parsed.capturedAt, parsed.capturedAt).run();
    const result = await ingestOk(cardiff.id, body, { key: 'failed-key' });
    expect(result.counts.created).toBe(1);
    expect((await dogByExternalId(cardiff.id, 'bella-2')).name).toBe('Bella');
    const rows = await env.DB.prepare('SELECT status, id FROM snapshots WHERE idempotency_key = ?').bind('failed-key').all<{ status: string; id: string }>();
    expect(rows.results).toEqual([{ status: 'done', id: result.snapshotId }]);
  });

  it('A post whose key is still being processed is told to retry, not applied again', async () => {
    const body = snapshot([found('Bella', 'bella-2')]);
    const parsed = { ...body, capturedAt: new Date(body.capturedAt).toISOString() };
    const hash = await sha256Hex(canonicalJson({ rescueId: cardiff.id, snapshot: { ...parsed, dogs: parsed.dogs.map((d) => ({ ...d, status: 'available', goodWithKids: null, goodWithDogs: null, goodWithCats: null, profileUrl: null, imageUrl: null, birthYear: null, birthMonth: null, birthDay: null, rescueSinceDate: null })) } }));
    await env.DB.prepare(`INSERT INTO snapshots (id, rescue_id, idempotency_key, body_hash, captured_at, processed_at, adapter, mode, complete, status, result) VALUES (?, ?, 'pending-key', ?, ?, ?, 'cardiff-dogs-home', 'fixture', 1, 'pending', NULL)`)
      .bind(crypto.randomUUID(), cardiff.id, hash, parsed.capturedAt, parsed.capturedAt).run();
    const res = await ingest(cardiff.id, body, { key: 'pending-key' });
    expect(res.status).toBe(409);
    expect((await json<Problem>(res)).detail).toMatch(/still being processed/);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dogs').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('A failure while applying marks the snapshot failed and answers 500 without claiming success', async () => {
    // Break the tail batch: a withdrawal must insert a status event, and the table is gone.
    await ingestOk(cardiff.id, snapshot([found('Max', 'max-7')], { capturedAt: '2026-10-18T08:00:00.000Z' }));
    await env.DB.prepare('DROP INDEX idx_dog_status_events_dog').run();
    await env.DB.prepare('ALTER TABLE dog_status_events RENAME TO dog_status_events_broken').run();
    try {
      const res = await ingest(cardiff.id, snapshot([]), { key: 'broken-key' });
      expect(res.status).toBe(500);
      expect((await json<Problem>(res)).errorCode).toBe('internal_error');
      const row = await env.DB.prepare('SELECT status, result FROM snapshots WHERE idempotency_key = ?').bind('broken-key').first<{ status: string; result: string | null }>();
      expect(row).toEqual({ status: 'failed', result: null });
    } finally {
      await env.DB.prepare('ALTER TABLE dog_status_events_broken RENAME TO dog_status_events').run();
      await env.DB.prepare('CREATE INDEX idx_dog_status_events_dog ON dog_status_events (dog_id, effective_at)').run();
    }
  });
});
