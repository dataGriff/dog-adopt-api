// Pure reconciliation of a RescueSnapshot against the dogs currently held
// for that rescue. No I/O: the caller loads existing dogs and a breed
// resolver, and applies the returned plan. Behaviour follows
// services/dogs-api/features/ingest-snapshot.feature.
import {
  ENQUIRABLE_STATUSES,
  EVENT_SOURCES,
  EVENT_TYPES,
  makeEvent,
  type DogEvent,
  type DogStatus,
  type RescueSnapshot,
} from '@dogadopt/contracts';
import type { DogBreed, DogWithBreeds } from './types.js';

type FoundDog = RescueSnapshot['dogs'][number];

export interface BreedResolver {
  /** Canonical breed name for a name as written, or null when unknown. */
  resolve(name: string): string | null;
}

/** Fields the finder may set. Everything else on a dog is hand-maintained. */
export interface DogFields {
  name: string;
  status: DogStatus;
  age: DogWithBreeds['age'];
  birth_year: number | null;
  birth_month: number | null;
  birth_day: number | null;
  size: DogWithBreeds['size'];
  gender: DogWithBreeds['gender'];
  good_with_kids: number | null;
  good_with_dogs: number | null;
  good_with_cats: number | null;
  image_url: string | null;
  profile_url: string | null;
  rescue_since_date: string | null;
}

export interface CreatePlan {
  id: string;
  externalId: string;
  fields: DogFields;
  breeds: DogBreed[];
}

export interface UpdatePlan {
  id: string;
  externalId: string;
  fields: DogFields;
  breeds: DogBreed[];
  /** camelCase Dog field names, as the AsyncAPI DogUpdated event wants them. */
  changedFields: string[];
  statusChanged: boolean;
}

export interface ReconcilePlan {
  creates: CreatePlan[];
  updates: UpdatePlan[];
  /** Unchanged dogs whose last_seen_at should advance to capturedAt. */
  touches: string[];
  withdrawals: { id: string; externalId: string; lastSeenAt: string }[];
  rejected: { externalId: string; reason: string }[];
  events: DogEvent[];
}

export interface ReconcileInput {
  rescueId: string;
  snapshotId: string;
  snapshot: RescueSnapshot;
  /** Every dog currently held for the rescue, finder-managed or not. */
  existing: DogWithBreeds[];
  breeds: BreedResolver;
  newId: () => string;
  now: Date;
}

const FIELD_TO_CAMEL: Record<keyof DogFields, string> = {
  name: 'name',
  status: 'status',
  age: 'age',
  birth_year: 'birthYear',
  birth_month: 'birthMonth',
  birth_day: 'birthDay',
  size: 'size',
  gender: 'gender',
  good_with_kids: 'goodWithKids',
  good_with_dogs: 'goodWithDogs',
  good_with_cats: 'goodWithCats',
  image_url: 'imageUrl',
  profile_url: 'profileUrl',
  rescue_since_date: 'rescueSinceDate',
};

const toInt = (v: boolean | null | undefined): number | null => (v === true ? 1 : v === false ? 0 : null);

export function fieldsFromFound(found: FoundDog): DogFields {
  return {
    name: found.name,
    status: found.status ?? 'available',
    age: found.age,
    birth_year: found.birthYear ?? null,
    birth_month: found.birthMonth ?? null,
    birth_day: found.birthDay ?? null,
    size: found.size,
    gender: found.gender,
    good_with_kids: toInt(found.goodWithKids),
    good_with_dogs: toInt(found.goodWithDogs),
    good_with_cats: toInt(found.goodWithCats),
    image_url: found.imageUrl ?? null,
    profile_url: found.profileUrl ?? null,
    rescue_since_date: found.rescueSinceDate ?? null,
  };
}

export function breedsFromFound(found: FoundDog, resolver: BreedResolver): DogBreed[] {
  const out: DogBreed[] = [];
  const seen = new Set<string>();
  for (const raw of found.breeds) {
    const name = raw.trim();
    if (!name) continue;
    const canonical = resolver.resolve(name);
    const key = (canonical ?? name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ displayOrder: out.length + 1, breedName: canonical, unresolvedName: canonical ? null : name });
  }
  return out;
}

function sameBreeds(a: DogBreed[], b: DogBreed[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.breedName === b[i]!.breedName && x.unresolvedName === b[i]!.unresolvedName);
}

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const { rescueId, snapshotId, snapshot, breeds, newId } = input;
  const capturedAt = snapshot.capturedAt;
  const plan: ReconcilePlan = { creates: [], updates: [], touches: [], withdrawals: [], rejected: [], events: [] };

  const byExternalId = new Map<string, DogWithBreeds>();
  for (const dog of input.existing) if (dog.external_id !== null) byExternalId.set(dog.external_id, dog);

  const seenInSnapshot = new Set<string>();
  const subject = (dogId: string) => dogId;

  for (const found of snapshot.dogs) {
    if (seenInSnapshot.has(found.externalId)) {
      plan.rejected.push({ externalId: found.externalId, reason: 'duplicate externalId in snapshot' });
      continue;
    }
    seenInSnapshot.add(found.externalId);

    const fields = fieldsFromFound(found);
    const dogBreeds = breedsFromFound(found, breeds);
    const existing = byExternalId.get(found.externalId);

    if (!existing) {
      const id = newId();
      plan.creates.push({ id, externalId: found.externalId, fields, breeds: dogBreeds });
      plan.events.push(
        makeEvent(EVENT_TYPES.dogListed, EVENT_SOURCES.dogsApi, subject(id), {
          dogId: id, rescueId, externalId: found.externalId, snapshotId, status: fields.status, name: fields.name,
        }),
      );
      continue;
    }

    const changedFields: string[] = [];
    for (const key of Object.keys(FIELD_TO_CAMEL) as (keyof DogFields)[]) {
      if (existing[key] !== fields[key]) changedFields.push(FIELD_TO_CAMEL[key]);
    }
    if (!sameBreeds(existing.breeds, dogBreeds)) changedFields.push('breeds');

    if (changedFields.length === 0) {
      plan.touches.push(existing.id);
      continue;
    }
    const statusChanged = existing.status !== fields.status;
    plan.updates.push({ id: existing.id, externalId: found.externalId, fields, breeds: dogBreeds, changedFields, statusChanged });
    plan.events.push(
      makeEvent(EVENT_TYPES.dogUpdated, EVENT_SOURCES.dogsApi, subject(existing.id), {
        dogId: existing.id, rescueId, externalId: found.externalId, snapshotId, status: fields.status, changedFields,
      }),
    );
  }

  if (snapshot.complete) {
    for (const dog of input.existing) {
      if (dog.external_id === null) continue; // hand-entered: never withdrawn by the finder
      if (seenInSnapshot.has(dog.external_id)) continue;
      if (!(ENQUIRABLE_STATUSES as readonly string[]).includes(dog.status)) continue; // already withdrawn or adopted
      if (dog.last_seen_at > capturedAt) continue; // a newer capture has already seen it
      plan.withdrawals.push({ id: dog.id, externalId: dog.external_id, lastSeenAt: dog.last_seen_at });
      plan.events.push(
        makeEvent(EVENT_TYPES.dogWithdrawn, EVENT_SOURCES.dogsApi, subject(dog.id), {
          dogId: dog.id, rescueId, externalId: dog.external_id, snapshotId, status: 'withdrawn', lastSeenAt: dog.last_seen_at,
        }),
      );
    }
  }

  return plan;
}
