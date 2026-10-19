import { Hono } from 'hono';
import {
  bearerMatches,
  canonicalJson,
  GetSnapshotResultParams,
  IngestRescueSnapshotBody,
  IngestRescueSnapshotHeader,
  IngestRescueSnapshotParams,
  ProblemError,
  sha256Hex,
  type DogEvent,
  type SnapshotResult,
} from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { reconcile } from '../reconcile.js';
import { Repo } from '../repo.js';
import { parseOr400, parseOr404 } from '../validate.js';

export const ingest = new Hono<{ Bindings: Env }>();

ingest.use('/v1/ingest/*', async (c, next) => {
  if (!bearerMatches(c.req.header('authorization'), c.env.FINDER_TOKEN)) throw new ProblemError('unauthorized');
  await next();
});

ingest.post('/v1/ingest/rescues/:rescueId/snapshots', async (c) => {
  const { rescueId } = parseOr404(IngestRescueSnapshotParams, c.req.param());
  const { 'Idempotency-Key': idempotencyKey } = parseOr400(IngestRescueSnapshotHeader, { 'Idempotency-Key': c.req.header('idempotency-key') }, 'headers');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ProblemError('validation_failed', { detail: 'Body must be JSON', errors: [{ path: '(root)', message: 'invalid JSON' }] });
  }
  const snapshot = parseOr400(IngestRescueSnapshotBody, raw, 'body');
  // The contract accepts any UTC offset; everything stored or compared is a `Z` ISO string with millisecond precision.
  snapshot.capturedAt = new Date(snapshot.capturedAt).toISOString();

  const repo = new Repo(c.env.DB);
  if (!(await repo.rescueExists(rescueId))) throw new ProblemError('not_found', { detail: `No rescue with id ${rescueId}` });

  const now = new Date();
  const snapshotId = crypto.randomUUID();
  const bodyHash = await sha256Hex(canonicalJson({ rescueId, snapshot }));

  // Claim the key before touching any dog so a concurrent duplicate cannot apply the plan twice.
  const claim = await repo.claimSnapshot({
    id: snapshotId, rescueId, idempotencyKey, bodyHash, capturedAt: snapshot.capturedAt, processedAt: now.toISOString(),
    adapter: snapshot.source.adapter, mode: snapshot.source.mode, complete: snapshot.complete,
  });
  if (!claim.claimed) {
    const { existing } = claim;
    if (existing.body_hash !== bodyHash || existing.rescue_id !== rescueId) {
      throw new ProblemError('idempotency_conflict', { detail: `Idempotency-Key ${idempotencyKey} was already used with a different snapshot` });
    }
    if (existing.status === 'done' && existing.result) return c.json(JSON.parse(existing.result) as SnapshotResult);
    throw new ProblemError('idempotency_conflict', { detail: `Idempotency-Key ${idempotencyKey} is still being processed; retry shortly` });
  }

  let result: SnapshotResult;
  let events: DogEvent[];
  try {
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
    result = {
      snapshotId,
      rescueId,
      capturedAt: snapshot.capturedAt,
      processedAt: now.toISOString(),
      counts: {
        received: snapshot.dogs.length,
        created: plan.creates.length - failedCreates,
        updated: plan.updates.length - failedUpdates,
        unchanged: plan.touches.length + plan.stale.length,
        withdrawn: plan.withdrawals.length,
        rejected: rejected.length,
      },
      rejected,
    };
    events = plan.events.filter((e) => !failedDogIds.has(e.data.dogId));
    await repo.finishSnapshot(snapshotId, now.toISOString(), result);
  } catch (err) {
    // Release the key so a retry with the same body re-processes instead of replaying a failure.
    await repo.failSnapshot(snapshotId);
    console.error('snapshot failed', snapshotId, err);
    throw new ProblemError('internal_error', { detail: 'The snapshot could not be applied; retry with the same Idempotency-Key' });
  }

  await publish(c.env.DOG_EVENTS, events);
  return c.json(result);
});

ingest.get('/v1/ingest/rescues/:rescueId/snapshots/:snapshotId', async (c) => {
  const { rescueId, snapshotId } = parseOr404(GetSnapshotResultParams, c.req.param());
  const result = await new Repo(c.env.DB).snapshotResult(rescueId, snapshotId);
  if (!result) throw new ProblemError('not_found', { detail: `No snapshot ${snapshotId} for rescue ${rescueId}` });
  return c.json(result);
});

/** Sends dog events to the queue in batches of 100 (the Queues limit). Nothing happens without the binding. */
async function publish(queue: Queue | undefined, events: DogEvent[]): Promise<void> {
  if (!queue || events.length === 0) return;
  for (let i = 0; i < events.length; i += 100) {
    await queue.sendBatch(events.slice(i, i + 100).map((body) => ({ body, contentType: 'json' as const })));
  }
}
