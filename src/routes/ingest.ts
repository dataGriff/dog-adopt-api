import { Hono } from 'hono';
import {
  GetSnapshotResultParams,
  IngestRescueSnapshotBody,
  IngestRescueSnapshotHeader,
  IngestRescueSnapshotParams,
  type DogEvent,
  type SnapshotResult,
} from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { ProblemError } from '../problems.js';
import { reconcile } from '../reconcile.js';
import { Repo } from '../repo.js';
import { canonicalJson, sha256Hex, timingSafeEqual } from '../security.js';
import { parseOr400, parseOr404 } from '../validate.js';

export const ingest = new Hono<{ Bindings: Env }>();

ingest.use('/v1/ingest/*', async (c, next) => {
  const expected = c.env.FINDER_TOKEN;
  const header = c.req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ', 2);
  if (!expected || scheme?.toLowerCase() !== 'bearer' || !token || !timingSafeEqual(token, expected)) {
    throw new ProblemError('unauthorized');
  }
  await next();
});

ingest.post('/v1/ingest/rescues/:rescueId/snapshots', async (c) => {
  const { rescueId } = parseOr404(IngestRescueSnapshotParams, c.req.param());
  const { 'Idempotency-Key': idempotencyKey } = parseOr400(IngestRescueSnapshotHeader, { 'Idempotency-Key': c.req.header('idempotency-key') }, 'headers');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ProblemError('validation_failed', 'Body must be JSON', [{ path: '(root)', message: 'invalid JSON' }]);
  }
  const snapshot = parseOr400(IngestRescueSnapshotBody, raw, 'body');

  const repo = new Repo(c.env.DB);
  if (!(await repo.rescueExists(rescueId))) throw new ProblemError('not_found', `No rescue with id ${rescueId}`);

  const bodyHash = await sha256Hex(canonicalJson({ rescueId, snapshot }));
  const previous = await repo.snapshotByKey(idempotencyKey);
  if (previous) {
    if (previous.body_hash !== bodyHash || previous.rescue_id !== rescueId) {
      throw new ProblemError('idempotency_conflict', `Idempotency-Key ${idempotencyKey} was already used with a different snapshot`);
    }
    return c.json(JSON.parse(previous.result) as SnapshotResult);
  }

  const now = new Date();
  const snapshotId = crypto.randomUUID();
  const plan = reconcile({
    rescueId,
    snapshotId,
    snapshot,
    existing: await repo.dogsOfRescue(rescueId),
    breeds: await repo.breedResolver(),
    newId: () => crypto.randomUUID(),
    now,
  });
  const { rejected, failedDogIds } = await repo.applyPlan(plan, { rescueId, snapshotId, capturedAt: snapshot.capturedAt, now: now.toISOString() });

  const failedCreates = plan.creates.filter((p) => failedDogIds.has(p.id)).length;
  const failedUpdates = plan.updates.filter((p) => failedDogIds.has(p.id)).length;
  const result: SnapshotResult = {
    snapshotId,
    rescueId,
    capturedAt: snapshot.capturedAt,
    processedAt: now.toISOString(),
    counts: {
      received: snapshot.dogs.length,
      created: plan.creates.length - failedCreates,
      updated: plan.updates.length - failedUpdates,
      unchanged: plan.touches.length,
      withdrawn: plan.withdrawals.length,
      rejected: rejected.length,
    },
    rejected,
  };
  await repo.recordSnapshot({
    id: snapshotId, rescueId, idempotencyKey, bodyHash, capturedAt: snapshot.capturedAt, processedAt: now.toISOString(),
    adapter: snapshot.source.adapter, mode: snapshot.source.mode, complete: snapshot.complete, result,
  });

  const events = plan.events.filter((e) => !failedDogIds.has(e.data.dogId));
  await publish(c.env.DOG_EVENTS, events);

  return c.json(result);
});

ingest.get('/v1/ingest/rescues/:rescueId/snapshots/:snapshotId', async (c) => {
  const { rescueId, snapshotId } = parseOr404(GetSnapshotResultParams, c.req.param());
  const result = await new Repo(c.env.DB).snapshotResult(rescueId, snapshotId);
  if (!result) throw new ProblemError('not_found', `No snapshot ${snapshotId} for rescue ${rescueId}`);
  return c.json(result);
});

/** Sends dog events to the queue in batches of 100 (the Queues limit). Nothing happens without the binding. */
async function publish(queue: Queue | undefined, events: DogEvent[]): Promise<void> {
  if (!queue || events.length === 0) return;
  for (let i = 0; i < events.length; i += 100) {
    await queue.sendBatch(events.slice(i, i + 100).map((body) => ({ body, contentType: 'json' as const })));
  }
}
