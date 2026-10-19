// One test per scenario in services/dogs-api/features/browse-dogs.feature.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GetDailyAvailability200Response,
  GetDog200Response,
  GetRescue200Response,
  ListBreeds200Response,
  ListDogs200Response,
  ListRescues200Response,
  type Dog,
  type DogPage,
  type Problem,
  type Rescue,
  type RescuePage,
} from '@dogadopt/contracts';
import { api, dateOnly, daysAgo, insertDog, insertRescue, json, rescueByName, setCoordinates } from './helpers.js';
import type { RescueRow } from '../src/types.js';

let cardiff: RescueRow;
let dogsTrust: RescueRow;
let bella: { id: string };

beforeEach(async () => {
  await setCoordinates('Cardiff Dogs Home', 51.48, -3.17);
  await setCoordinates('Dogs Trust', null, null);
  cardiff = await rescueByName('Cardiff Dogs Home');
  dogsTrust = await rescueByName('Dogs Trust');
  bella = await insertDog(cardiff, { name: 'Bella', status: 'available', age: 'Adult', size: 'Medium', gender: 'Female', breeds: ['Staffordshire Bull Terrier'], goodWithKids: true, goodWithCats: false, since: daysAgo(3), profileUrl: 'https://www.cardiffdogshome.co.uk/dog/bella-2/' });
  await insertDog(cardiff, { name: 'Max', status: 'reserved', age: 'Young', size: 'Large', gender: 'Male', breeds: ['Labrador Retriever'], goodWithKids: null, goodWithCats: null, since: daysAgo(2) });
  await insertDog(cardiff, { name: 'Rex', status: 'adopted', age: 'Adult', size: 'Large', gender: 'Male', breeds: ['German Shepherd'], goodWithKids: true, goodWithCats: true });
  await insertDog(cardiff, { name: 'Tiny', status: 'withdrawn', age: 'Puppy', size: 'Small', gender: 'Female', breeds: ['Chihuahua'], goodWithKids: false, goodWithCats: false });
  await insertDog(dogsTrust, { name: 'Dot', status: 'available', age: 'Senior', size: 'Small', gender: 'Female', breeds: ['Jack Russell Terrier'], since: daysAgo(1) });
});

async function listDogs(qs = ''): Promise<DogPage> {
  const res = await api(`/v1/dogs${qs ? `?${qs}` : ''}`);
  expect(res.status).toBe(200);
  const body = await json<DogPage>(res);
  expect(ListDogs200Response.safeParse(body).success, 'response matches the contract').toBe(true);
  return body;
}
const names = (page: DogPage) => page.items.map((d) => d.name).sort();

describe('Browsing dogs and rescues', () => {
  it('Listing dogs shows only enquirable dogs by default', async () => {
    const page = await listDogs();
    expect(names(page)).toEqual(['Bella', 'Dot', 'Max']);
    expect(page.meta.total).toBe(3);
  });

  it('Status can be chosen explicitly', async () => {
    expect(names(await listDogs('status=adopted,withdrawn'))).toEqual(['Rex', 'Tiny']);
    expect(names(await listDogs('status=adopted&status=withdrawn'))).toEqual(['Rex', 'Tiny']);
  });

  describe('Dogs are filtered by their attributes', () => {
    it.each([
      ['size=Small', ['Dot']],
      ['age=Young', ['Max']],
      ['gender=Female', ['Bella', 'Dot']],
      ['breed=Labrador%20Retriever', ['Max']],
      ['region=South%20Wales', ['Bella', 'Max']],
      ['goodWithKids=true', ['Bella']],
      ['goodWithCats=false', ['Bella']],
      ['q=bel', ['Bella']],
      ['q=staff', ['Bella']],
    ])('%s -> %j', async (qs, expected) => {
      expect(names(await listDogs(qs))).toEqual(expected);
    });
    it('rescueId of "Dogs Trust" -> ["Dot"]', async () => {
      expect(names(await listDogs(`rescueId=${dogsTrust.id}`))).toEqual(['Dot']);
    });
  });

  it('An unknown compatibility is neither true nor false', async () => {
    expect(names(await listDogs('goodWithKids=false'))).toEqual([]);
    expect(names(await listDogs('goodWithKids=true'))).not.toContain('Max');
  });

  it('Pagination is honoured and described', async () => {
    for (let i = 0; i < 30; i++) await insertDog(dogsTrust, { name: `Extra ${i}` });
    const page = await listDogs('page=2&pageSize=24');
    expect(page.items).toHaveLength(9);
    expect(page.meta).toEqual({ page: 2, pageSize: 24, total: 33, totalPages: 2 });
  });

  describe('Invalid query parameters are rejected', () => {
    it.each(['pageSize=101', 'page=0', 'size=Huge', 'status=lost', 'lat=91', 'radiusKm=5'])('%s', async (qs) => {
      const res = await api(`/v1/dogs?${qs}`);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const problem = await json<Problem>(res);
      expect(problem.errorCode).toBe('validation_failed');
      expect(problem.errors?.length).toBeGreaterThan(0);
    });
  });

  it('Distance is computed from the rescue when a location is given', async () => {
    const page = await listDogs('lat=51.5&lng=-3.2');
    for (const dog of page.items.filter((d) => d.rescue.id === cardiff.id)) expect(dog.distanceKm).toBeLessThan(10);
    const dot = page.items.find((d) => d.name === 'Dot') as Dog;
    expect(dot.distanceKm).toBeUndefined();
    expect(page.items[page.items.length - 1]?.name).toBe('Dot');
  });

  it('Radius excludes distant dogs and dogs with unknown distance', async () => {
    expect(names(await listDogs('lat=51.5&lng=-3.2&radiusKm=5'))).toEqual(['Bella', 'Max']);
  });

  it('A dog can be fetched by id', async () => {
    const res = await api(`/v1/dogs/${bella.id}`);
    expect(res.status).toBe(200);
    const dog = await json<Dog>(res);
    expect(GetDog200Response.safeParse(dog).success).toBe(true);
    expect(dog).toMatchObject({ id: bella.id, name: 'Bella', status: 'available', breeds: ['Staffordshire Bull Terrier'] });
    expect(dog.rescue).toEqual({ id: cardiff.id, name: cardiff.name, region: cardiff.region, website: cardiff.website });
    for (const key of ['description', 'imageUrl', 'birthYear', 'birthMonth', 'birthDay', 'rescueSinceDate', 'statusNotes', 'goodWithDogs'] as const) {
      expect(dog).toHaveProperty(key);
      expect(dog[key]).toBeNull();
    }
  });

  it('Fetching an unknown dog returns 404', async () => {
    for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
      const res = await api(`/v1/dogs/${id}`);
      expect(res.status).toBe(404);
      expect((await json<Problem>(res)).errorCode).toBe('not_found');
    }
  });

  it("A dog's age is derived from its birth date when known", async () => {
    const year = new Date().getUTCFullYear() - 2;
    const dog = await insertDog(cardiff, { name: 'Birthday', age: 'Senior', birthYear: year, birthMonth: null });
    expect((await json<Dog>(await api(`/v1/dogs/${dog.id}`))).age).toBe('Young');
    expect(names(await listDogs('age=Young'))).toEqual(['Birthday', 'Max']);
    expect(names(await listDogs('age=Senior'))).toEqual(['Dot']);
  });

  it('Rescues list with their enquirable dog count', async () => {
    const res = await api('/v1/rescues?pageSize=100');
    expect(res.status).toBe(200);
    const page = await json<RescuePage>(res);
    expect(ListRescues200Response.safeParse(page).success).toBe(true);
    const sorted = [...page.items].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    expect(page.items.map((r) => r.name)).toEqual(sorted.map((r) => r.name));
    expect(page.items.find((r) => r.name === 'Cardiff Dogs Home')?.dogCount).toBe(2);
    expect(page.items.find((r) => r.name === 'Dogs Trust')?.dogCount).toBe(1);
    const one = await json<Rescue>(await api(`/v1/rescues/${cardiff.id}`));
    expect(GetRescue200Response.safeParse(one).success).toBe(true);
    expect(one.dogCount).toBe(2);
    expect((await api(`/v1/rescues/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('Rescues can be limited to those with dogs', async () => {
    await insertRescue('Empty Paws');
    const page = await json<RescuePage>(await api('/v1/rescues?hasDogs=true&pageSize=100'));
    expect(page.items.map((r) => r.name)).not.toContain('Empty Paws');
    expect(page.items.map((r) => r.name).sort()).toEqual(['Cardiff Dogs Home', 'Dogs Trust']);
    const all = await json<RescuePage>(await api('/v1/rescues?q=empty'));
    expect(all.items.map((r) => r.name)).toEqual(['Empty Paws']);
  });

  it("A rescue's dogs can be listed on their own", async () => {
    const res = await api(`/v1/rescues/${cardiff.id}/dogs`);
    expect(res.status).toBe(200);
    const page = await json<DogPage>(res);
    expect(ListDogs200Response.safeParse(page).success).toBe(true);
    expect(names(page)).toEqual(['Bella', 'Max']);
    expect(names(await json<DogPage>(await api(`/v1/rescues/${cardiff.id}/dogs?status=adopted`)))).toEqual(['Rex']);
  });

  it('Listing dogs for an unknown rescue returns 404', async () => {
    expect((await api(`/v1/rescues/${crypto.randomUUID()}/dogs`)).status).toBe(404);
  });

  it('Breeds list canonical names with synonyms', async () => {
    const res = await api('/v1/breeds');
    expect(res.status).toBe(200);
    const body = await json<{ items: { name: string; synonyms: string[] }[] }>(res);
    expect(ListBreeds200Response.safeParse(body).success).toBe(true);
    const staffie = body.items.find((b) => b.name === 'Staffordshire Bull Terrier');
    expect(staffie?.synonyms).toEqual(expect.arrayContaining(['Staffie', 'Staffy']));
    const canonical = new Set(body.items.map((b) => b.name.toLowerCase()));
    for (const b of body.items) for (const s of b.synonyms) expect(canonical.has(s.toLowerCase())).toBe(false);
  });

  it('Daily availability reports available dogs per day', async () => {
    const res = await api(`/v1/reports/daily-availability?from=${dateOnly(daysAgo(4))}&to=${dateOnly(new Date())}`);
    expect(res.status).toBe(200);
    const report = await json<{ items: { date: string; availableCount: number }[] }>(res);
    expect(GetDailyAvailability200Response.safeParse(report).success).toBe(true);
    expect(report.items).toHaveLength(5);
    expect(report.items.map((i) => i.date)).toEqual([4, 3, 2, 1, 0].map((n) => dateOnly(daysAgo(n))));
    expect(report.items[0]?.availableCount).toBe(0);
    expect(report.items[2]?.availableCount).toBe(1);
    expect(report.items[4]?.availableCount).toBe(2);
  });

  it('Daily availability can be scoped to a rescue', async () => {
    const report = await json<{ items: { availableCount: number }[] }>(await api(`/v1/reports/daily-availability?from=${dateOnly(daysAgo(4))}&to=${dateOnly(new Date())}&rescueId=${dogsTrust.id}`));
    expect(report.items[4]?.availableCount).toBe(1);
  });

  it('Daily availability rejects a reversed range', async () => {
    const res = await api(`/v1/reports/daily-availability?from=${dateOnly(new Date())}&to=${dateOnly(daysAgo(4))}`);
    expect(res.status).toBe(400);
    expect((await json<Problem>(res)).errorCode).toBe('validation_failed');
  });
});
