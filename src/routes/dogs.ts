import { Hono } from 'hono';
import {
  ENQUIRABLE_STATUSES,
  GetDogParams,
  LIST_DOGS_QUERY_SHAPE,
  LIST_RESCUE_DOGS_QUERY_SHAPE,
  ListDogsQueryParams,
  ListRescueDogsParams,
  ListRescueDogsQueryParams,
  normalizeQuery,
  type Dog,
  type DogPage,
} from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { haversineKm } from '../geo.js';
import { pageMeta, toDog } from '../mappers.js';
import { ProblemError } from '../problems.js';
import { Repo, type DogListFilters } from '../repo.js';
import { parseOr400, parseOr404 } from '../validate.js';

type Query = ReturnType<typeof ListDogsQueryParams.parse>;

export const dogs = new Hono<{ Bindings: Env }>();

dogs.get('/v1/dogs', async (c) => {
  const query = parseOr400(ListDogsQueryParams, normalizeQuery(new URL(c.req.url).searchParams, LIST_DOGS_QUERY_SHAPE), 'query');
  return c.json(await listDogs(new Repo(c.env.DB), query));
});

dogs.get('/v1/dogs/:dogId', async (c) => {
  const { dogId } = parseOr404(GetDogParams, c.req.param());
  const row = await new Repo(c.env.DB).getDog(dogId, new Date());
  if (!row) throw new ProblemError('not_found', `No dog with id ${dogId}`);
  return c.json(toDog(row, new Date()));
});

dogs.get('/v1/rescues/:rescueId/dogs', async (c) => {
  const { rescueId } = parseOr404(ListRescueDogsParams, c.req.param());
  const query = parseOr400(ListRescueDogsQueryParams, normalizeQuery(new URL(c.req.url).searchParams, LIST_RESCUE_DOGS_QUERY_SHAPE), 'query');
  const repo = new Repo(c.env.DB);
  if (!(await repo.rescueExists(rescueId))) throw new ProblemError('not_found', `No rescue with id ${rescueId}`);
  return c.json(await listDogs(repo, { ...query, rescueId }));
});

async function listDogs(repo: Repo, query: Partial<Query> & { page: number; pageSize: number }): Promise<DogPage> {
  const now = new Date();
  const geo = query.lat !== undefined || query.lng !== undefined || query.radiusKm !== undefined;
  if (geo && (query.lat === undefined || query.lng === undefined)) {
    throw new ProblemError('validation_failed', 'lat and lng must be given together, and radiusKm only with both', [
      { path: query.lat === undefined ? 'lat' : 'lng', message: 'required with lng, lat or radiusKm' },
    ]);
  }
  const filters: DogListFilters = {
    statuses: query.status && query.status.length ? query.status : ENQUIRABLE_STATUSES,
    size: query.size,
    age: query.age,
    gender: query.gender,
    breed: query.breed,
    rescueId: query.rescueId,
    region: query.region,
    goodWithKids: query.goodWithKids,
    goodWithDogs: query.goodWithDogs,
    goodWithCats: query.goodWithCats,
    q: query.q,
  };

  if (!geo) {
    const { items, total } = await repo.listDogs(filters, now, { page: query.page, pageSize: query.pageSize });
    return { items: items.map((r) => toDog(r, now)), meta: pageMeta(query.page, query.pageSize, total) };
  }

  // Distance ordering: every match is loaded, measured, filtered and paged here.
  const lat = query.lat as number;
  const lng = query.lng as number;
  const { items } = await repo.listDogs(filters, now, null);
  let measured: { dog: Dog; distance: number | null }[] = items.map((r) => {
    const distance = r.rescue_latitude !== null && r.rescue_longitude !== null ? haversineKm(lat, lng, r.rescue_latitude, r.rescue_longitude) : null;
    return { dog: toDog(r, now, distance === null ? undefined : round(distance)), distance };
  });
  if (query.radiusKm !== undefined) measured = measured.filter((m) => m.distance !== null && m.distance <= (query.radiusKm as number));
  measured.sort((a, b) => {
    if (a.distance === null && b.distance === null) return 0;
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return a.distance - b.distance;
  });
  const start = (query.page - 1) * query.pageSize;
  return { items: measured.slice(start, start + query.pageSize).map((m) => m.dog), meta: pageMeta(query.page, query.pageSize, measured.length) };
}

const round = (km: number) => Math.round(km * 100) / 100;
