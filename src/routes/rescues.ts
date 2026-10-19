import { Hono } from 'hono';
import { GetRescueParams, LIST_RESCUES_QUERY_SHAPE, ListRescuesQueryParams, normalizeQuery, type RescuePage } from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { pageMeta, toRescue } from '../mappers.js';
import { ProblemError } from '../problems.js';
import { Repo } from '../repo.js';
import { parseOr400, parseOr404 } from '../validate.js';

export const rescues = new Hono<{ Bindings: Env }>();

rescues.get('/v1/rescues', async (c) => {
  const query = parseOr400(ListRescuesQueryParams, normalizeQuery(new URL(c.req.url).searchParams, LIST_RESCUES_QUERY_SHAPE), 'query');
  const { items, total } = await new Repo(c.env.DB).listRescues({ region: query.region, q: query.q, hasDogs: query.hasDogs }, query.page, query.pageSize);
  const body: RescuePage = { items: items.map(toRescue), meta: pageMeta(query.page, query.pageSize, total) };
  return c.json(body);
});

rescues.get('/v1/rescues/:rescueId', async (c) => {
  const { rescueId } = parseOr404(GetRescueParams, c.req.param());
  const row = await new Repo(c.env.DB).getRescue(rescueId);
  if (!row) throw new ProblemError('not_found', `No rescue with id ${rescueId}`);
  return c.json(toRescue(row));
});
