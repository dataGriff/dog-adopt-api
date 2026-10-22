// One test per scenario in services/dogs-api/features/ingest-snapshot.feature.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { IngestRescueSnapshot200Response, type DogEvent, type Problem, type SnapshotResult } from '@dogadopt/contracts';
import { api, dogByExternalId, dogRow, fakeQueue, found, ingest, ingestOk, insertDog, iso, json, rescueByName, snapshot, daysAgo } from './helpers.js';
import type { RescueRow } from '../src/types.js';

let cardiff: RescueRow;

beforeEach(async () => {
  cardiff = await rescueByName('Cardiff Dogs Home');
});

async function statusEvents(dogId: string) {
  return (await env.DB.prepare('SELECT status, effective_at FROM dog_status_events WHERE dog_id = ? ORDER BY id').bind(dogId).all<{ status: string; effective_at: string }>()).results;
}

describe('Ingesting a rescue snapshot', () => {
  it('A snapshot of a rescue with no dogs creates them all', async () => {
    const queue = fakeQueue();
    const body = snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')]);
    const result = await ingestOk(cardiff.id, body, { queue });
    expect(IngestRescueSnapshot200Response.safeParse(result).success).toBe(true);
    expect(result.counts).toEqual({ received: 2, created: 2, updated: 0, unchanged: 0, withdrawn: 0, rejected: 0 });
    for (const ext of ['bella-2', 'max-7']) {
      const dog = await dogByExternalId(cardiff.id, ext);
      expect(dog.status).toBe('available');
      expect(dog.first_seen_at).toBe(body.capturedAt);
      expect(dog.last_seen_at).toBe(body.capturedAt);
      expect(await statusEvents(dog.id)).toEqual([{ status: 'available', effective_at: body.capturedAt }]);
    }
    const events = queue.sent as DogEvent[];
    expect(events.map((e) => e.type)).toEqual(['uk.co.dogadopt.dogs.listed.v1', 'uk.co.dogadopt.dogs.listed.v1']);
    expect(events.map((e) => (e.data as { name: string }).name).sort()).toEqual(['Bella', 'Max']);
  });

  it('A dog is matched on externalId within the rescue, not on name', async () => {
    const queue = fakeQueue();
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')]));
    const result = await ingestOk(cardiff.id, snapshot([found('Bella Rose', 'bella-2')]), { queue });
    expect(result.counts.created).toBe(0);
    expect(result.counts.updated).toBe(1);
    expect((await dogByExternalId(cardiff.id, 'bella-2')).name).toBe('Bella Rose');
    const event = queue.sent[0] as DogEvent;
    expect(event.type).toBe('uk.co.dogadopt.dogs.updated.v1');
    expect((event.data as { changedFields: string[] }).changedFields).toContain('name');
  });

  it('Two rescues can list dogs with the same externalId', async () => {
    const dogsTrust = await rescueByName('Dogs Trust');
    const dot = await insertDog(dogsTrust, { name: 'Dot', externalId: 'dog-1' });
    const result = await ingestOk(cardiff.id, snapshot([found('Dusty', 'dog-1')]));
    expect(result.counts.created).toBe(1);
    expect((await dogRow(dot.id)).name).toBe('Dot');
    expect((await dogByExternalId(cardiff.id, 'dog-1')).name).toBe('Dusty');
  });

  it('An unchanged dog only has its lastSeenAt advanced', async () => {
    const yesterday = iso(daysAgo(1));
    const today = iso(new Date());
    const dog = found('Bella', 'bella-2');
    await ingestOk(cardiff.id, snapshot([dog], { capturedAt: yesterday }));
    const queue = fakeQueue();
    const result = await ingestOk(cardiff.id, snapshot([dog], { capturedAt: today }), { queue });
    expect(result.counts.unchanged).toBe(1);
    expect(result.counts.updated).toBe(0);
    const row = await dogByExternalId(cardiff.id, 'bella-2');
    expect(row.last_seen_at).toBe(today);
    expect(row.first_seen_at).toBe(yesterday);
    expect(queue.sent).toEqual([]);
  });

  it('A dog missing from a complete snapshot is withdrawn', async () => {
    const earlier = iso(daysAgo(1));
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')], { capturedAt: earlier }));
    const queue = fakeQueue();
    const result = await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')]), { queue });
    expect(result.counts.withdrawn).toBe(1);
    const max = await dogByExternalId(cardiff.id, 'max-7');
    expect(max.status).toBe('withdrawn');
    expect(max.last_seen_at).toBe(earlier);
    expect((await statusEvents(max.id)).map((e) => e.status)).toEqual(['available', 'withdrawn']);
    const event = queue.sent[0] as DogEvent;
    expect(event.type).toBe('uk.co.dogadopt.dogs.withdrawn.v1');
    expect(event.data.externalId).toBe('max-7');
  });

  it('A dog missing from a partial snapshot is left alone', async () => {
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')]));
    const result = await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')], { complete: false }));
    expect(result.counts.withdrawn).toBe(0);
    expect((await dogByExternalId(cardiff.id, 'max-7')).status).toBe('available');
  });

  it('A withdrawn dog that reappears is listed again', async () => {
    const max = await insertDog(cardiff, { name: 'Max', externalId: 'max-7', status: 'withdrawn' });
    const queue = fakeQueue();
    const result = await ingestOk(cardiff.id, snapshot([found('Max', 'max-7')]), { queue });
    expect(result.counts.updated).toBe(1);
    expect((await dogRow(max.id)).status).toBe('available');
    const event = queue.sent[0] as DogEvent;
    expect(event.type).toBe('uk.co.dogadopt.dogs.updated.v1');
    expect((event.data as { changedFields: string[] }).changedFields).toContain('status');
  });

  it('Dogs that were entered by hand are never withdrawn by the finder', async () => {
    const hand = await insertDog(cardiff, { name: 'Hand Entered', externalId: null });
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')]));
    expect((await dogRow(hand.id)).status).toBe('available');
  });

  it('Breed names are resolved through synonyms', async () => {
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2', { breeds: ['Staffie', 'lab'] })]));
    const dog = await json<{ breeds: string[]; unresolvedBreeds: string[] }>(await api(`/v1/dogs/${(await dogByExternalId(cardiff.id, 'bella-2')).id}`));
    expect(dog.breeds).toEqual(['Staffordshire Bull Terrier', 'Labrador Retriever']);
    expect(dog.unresolvedBreeds).toEqual([]);
  });

  it('An unknown breed is kept as unresolved, not rejected', async () => {
    const result = await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2', { breeds: ['Sprollie'] })]));
    expect(result.counts).toMatchObject({ created: 1, rejected: 0 });
    const dog = await json<{ breeds: string[]; unresolvedBreeds: string[] }>(await api(`/v1/dogs/${(await dogByExternalId(cardiff.id, 'bella-2')).id}`));
    expect(dog.breeds).toEqual([]);
    expect(dog.unresolvedBreeds).toEqual(['Sprollie']);
  });

  it('Descriptions and images are never taken from the snapshot', async () => {
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2', { imageUrl: 'https://www.cardiffdogshome.co.uk/img/bella.jpg' })]));
    const row = await dogByExternalId(cardiff.id, 'bella-2');
    expect(row.image_url).toBe('https://www.cardiffdogshome.co.uk/img/bella.jpg');
    expect(row.description).toBeNull();
    // A description in the body is not part of the contract and is rejected outright.
    const res = await ingest(cardiff.id, snapshot([{ ...found('Bella', 'bella-2'), description: 'copied text' } as never]));
    expect(res.status).toBe(400);
  });

  it('A dog that fails storage is reported, not fatal', async () => {
    const res = await ingest(cardiff.id, snapshot([found('Bella', 'bella-2'), found('Bella again', 'bella-2')]));
    expect(res.status).toBe(200);
    const result = await json<SnapshotResult>(res);
    expect(result.counts.rejected).toBe(1);
    expect(result.rejected[0]).toMatchObject({ externalId: 'bella-2' });
    expect(result.rejected[0]?.reason).toBeTruthy();
    expect((await dogByExternalId(cardiff.id, 'bella-2')).name).toBe('Bella');
  });

  it('Replaying an Idempotency-Key returns the original result', async () => {
    const body = snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')]);
    const queue = fakeQueue();
    const first = await ingestOk(cardiff.id, body, { key: 'snap-1-key', queue });
    expect(first.counts.created).toBe(2);
    const again = await ingestOk(cardiff.id, body, { key: 'snap-1-key', queue });
    expect(again).toEqual(first);
    expect(queue.sent).toHaveLength(2);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dogs WHERE rescue_id = ?').bind(cardiff.id).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('A different body on a used Idempotency-Key is rejected', async () => {
    await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')]), { key: 'snap-1-key' });
    const res = await ingest(cardiff.id, snapshot([found('Max', 'max-7')]), { key: 'snap-1-key' });
    expect(res.status).toBe(409);
    expect((await json<Problem>(res)).errorCode).toBe('idempotency_conflict');
  });

  it('The result of a snapshot can be fetched later', async () => {
    const result = await ingestOk(cardiff.id, snapshot([found('Bella', 'bella-2')]));
    const res = await api(`/v1/ingest/rescues/${cardiff.id}/snapshots/${result.snapshotId}`, { headers: { authorization: 'Bearer test-finder-token' } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(result);
    expect((await api(`/v1/ingest/rescues/${cardiff.id}/snapshots/${crypto.randomUUID()}`, { headers: { authorization: 'Bearer test-finder-token' } })).status).toBe(404);
    expect((await api(`/v1/ingest/rescues/${cardiff.id}/snapshots/${result.snapshotId}`)).status).toBe(401);
  });

  describe('Requests without a valid service token are refused', () => {
    it.each([
      ['no Authorization header', null],
      ['a bearer token that is wrong', 'wrong-token'],
    ])('%s', async (_label, token) => {
      const res = await ingest(cardiff.id, snapshot([found('Bella', 'bella-2')]), { token });
      expect(res.status).toBe(401);
      expect((await json<Problem>(res)).errorCode).toBe('unauthorized');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dogs').first<{ n: number }>();
      expect(count?.n).toBe(0);
    });
  });

  it('A snapshot for an unknown rescue is refused', async () => {
    const res = await ingest(crypto.randomUUID(), snapshot([found('Bella', 'bella-2')]));
    expect(res.status).toBe(404);
    expect((await json<Problem>(res)).errorCode).toBe('not_found');
  });

  describe('An invalid snapshot body is rejected whole', () => {
    const good = () => snapshot([found('Bella', 'bella-2'), found('Max', 'max-7')]);
    const cases: [string, () => unknown, string, boolean?][] = [
      ['without capturedAt', () => { const s = good(); delete (s as { capturedAt?: string }).capturedAt; return s; }, 'capturedAt'],
      ['with a dog missing externalId', () => { const s = good(); delete (s.dogs[1] as { externalId?: string }).externalId; return s; }, 'dogs.1.externalId'],
      ['with a dog whose size is "Huge"', () => { const s = good(); (s.dogs[0] as { size: string }).size = 'Huge'; return s; }, 'dogs.0.size'],
      ['with a dog whose status is "withdrawn"', () => { const s = good(); (s.dogs[0] as { status: string }).status = 'withdrawn'; return s; }, 'dogs.0.status'],
      ['with source.mode "scraped"', () => { const s = good(); (s.source as { mode: string }).mode = 'scraped'; return s; }, 'source.mode'],
      ['with an unknown top-level property', () => ({ ...good(), extra: true }), '(root)'],
      ['without an Idempotency-Key header', good, 'Idempotency-Key', true],
    ];
    it.each(cases)('%s', async (_label, make, path, noKey) => {
      const res = await ingest(cardiff.id, make(), { noKey: noKey ?? false });
      expect(res.status).toBe(400);
      const problem = await json<Problem>(res);
      expect(problem.errorCode).toBe('validation_failed');
      expect(problem.errors?.map((e) => e.path)).toContain(path);
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dogs').first<{ n: number }>();
      expect(count?.n).toBe(0);
    });
  });
});
