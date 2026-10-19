import { describe, expect, it } from 'vitest';
import { breedsFromFound, reconcile, type BreedResolver } from '../src/reconcile.js';
import type { DogWithBreeds } from '../src/types.js';

const resolver: BreedResolver = {
  resolve: (n) => ({ staffie: 'Staffordshire Bull Terrier', lab: 'Labrador Retriever', 'labrador retriever': 'Labrador Retriever' })[n.toLowerCase()] ?? null,
};

const base = (over: Partial<DogWithBreeds> = {}): DogWithBreeds => ({
  id: 'd1', rescue_id: 'r1', external_id: 'bella-2', name: 'Bella', status: 'available', status_notes: null, age: 'Adult', birth_year: null, birth_month: null, birth_day: null,
  size: 'Medium', gender: 'Female', good_with_kids: null, good_with_dogs: null, good_with_cats: null, image_url: null, profile_url: null, description: null,
  rescue_since_date: null, first_seen_at: '2026-10-01T00:00:00.000Z', last_seen_at: '2026-10-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  breeds: [{ displayOrder: 1, breedName: 'Staffordshire Bull Terrier', unresolvedName: null }], withdrawn_at: null, ...over,
});

const input = (existing: DogWithBreeds[], dogs: Parameters<typeof reconcile>[0]['snapshot']['dogs'], complete = true) => ({
  rescueId: 'r1', snapshotId: 's1', existing, breeds: resolver, newId: () => 'new', now: new Date('2026-10-19T00:00:00Z'),
  snapshot: { capturedAt: '2026-10-19T08:00:00.000Z', source: { adapter: 'cardiff-dogs-home', url: 'https://x.y/', mode: 'fixture' as const }, complete, dogs },
});
const dog = (externalId: string, name: string, extra = {}) => ({ externalId, name, status: 'available' as const, age: 'Adult' as const, size: 'Medium' as const, gender: 'Female' as const, breeds: ['Staffie'], goodWithKids: null, goodWithDogs: null, goodWithCats: null, profileUrl: null, imageUrl: null, birthYear: null, birthMonth: null, birthDay: null, rescueSinceDate: null, ...extra });

describe('reconcile', () => {
  it('creates, updates, touches and withdraws in one plan', () => {
    const plan = reconcile(input([base(), base({ id: 'd2', external_id: 'max-7', name: 'Max' })], [dog('bella-2', 'Bella'), dog('new-1', 'Newbie')]));
    expect(plan.touches).toEqual(['d1']);
    expect(plan.creates.map((c) => c.externalId)).toEqual(['new-1']);
    expect(plan.withdrawals.map((w) => w.id)).toEqual(['d2']);
    expect(plan.events.map((e) => e.type)).toEqual(['uk.co.dogadopt.dogs.listed.v1', 'uk.co.dogadopt.dogs.withdrawn.v1']);
  });
  it('reports changed fields in camelCase including breeds', () => {
    const plan = reconcile(input([base()], [dog('bella-2', 'Bella Rose', { breeds: ['Lab'], goodWithKids: true })]));
    expect(plan.updates[0]?.changedFields.sort()).toEqual(['breeds', 'goodWithKids', 'name']);
    expect(plan.updates[0]?.statusChanged).toBe(false);
  });
  it('rejects a duplicate externalId within the snapshot and keeps the first', () => {
    const plan = reconcile(input([], [dog('a', 'A'), dog('a', 'A again')]));
    expect(plan.creates).toHaveLength(1);
    expect(plan.rejected).toEqual([{ externalId: 'a', reason: 'duplicate externalId in snapshot' }]);
  });
  it('does not withdraw hand-entered, adopted, or more recently seen dogs, nor on a partial snapshot', () => {
    const existing = [
      base({ id: 'hand', external_id: null }),
      base({ id: 'adopted', external_id: 'x', status: 'adopted' }),
      base({ id: 'newer', external_id: 'y', last_seen_at: '2026-10-20T00:00:00.000Z' }),
      base({ id: 'gone', external_id: 'z' }),
    ];
    expect(reconcile(input(existing, [])).withdrawals.map((w) => w.id)).toEqual(['gone']);
    expect(reconcile(input(existing, [], false)).withdrawals).toEqual([]);
  });
  it('treats a snapshot older than a dog\'s last sighting or withdrawal as stale', () => {
    const existing = [
      base({ id: 'seen-later', external_id: 'a', last_seen_at: '2026-10-19T09:00:00.000Z' }),
      base({ id: 'withdrawn-later', external_id: 'b', status: 'withdrawn', last_seen_at: '2026-10-19T07:00:00.000Z', withdrawn_at: '2026-10-19T09:00:00.000Z' }),
      base({ id: 'current', external_id: 'c', last_seen_at: '2026-10-19T07:00:00.000Z' }),
    ];
    const plan = reconcile(input(existing, [dog('a', 'Renamed'), dog('b', 'Back'), dog('c', 'Renamed too')]));
    expect(plan.stale.sort()).toEqual(['seen-later', 'withdrawn-later']);
    expect(plan.updates.map((u) => u.id)).toEqual(['current']);
    expect(plan.events).toHaveLength(1);
  });
  it('resolves breeds through synonyms, keeps unknowns, and drops duplicates', () => {
    expect(breedsFromFound(dog('a', 'A', { breeds: ['Staffie', 'Staffordshire Bull Terrier', 'Sprollie', ' lab '] }), resolver)).toEqual([
      { displayOrder: 1, breedName: 'Staffordshire Bull Terrier', unresolvedName: null },
      { displayOrder: 2, breedName: null, unresolvedName: 'Sprollie' },
      { displayOrder: 3, breedName: 'Labrador Retriever', unresolvedName: null },
    ]);
  });
});
