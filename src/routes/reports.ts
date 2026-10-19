import { Hono } from 'hono';
import { GetDailyAvailabilityQueryParams, normalizeQuery, ProblemError, type DailyAvailabilityReport } from '@dogadopt/contracts';
import type { Env } from '../env.js';
import { Repo, type StatusEventRow } from '../repo.js';
import { parseOr400 } from '../validate.js';

export const reports = new Hono<{ Bindings: Env }>();

/** Longest span one report may cover, in days inclusive. Keeps a public endpoint bounded. */
export const MAX_REPORT_DAYS = 366;

reports.get('/v1/reports/daily-availability', async (c) => {
  const query = parseOr400(GetDailyAvailabilityQueryParams, normalizeQuery(new URL(c.req.url).searchParams), 'query');
  if (query.from > query.to) {
    throw new ProblemError('validation_failed', { detail: 'from must not be after to', errors: [{ path: 'from', message: 'must not be after to' }] });
  }
  if (daysInclusive(query.from, query.to) > MAX_REPORT_DAYS) {
    throw new ProblemError('validation_failed', {
      detail: `The report may cover at most ${MAX_REPORT_DAYS} days`,
      errors: [{ path: 'to', message: `must be within ${MAX_REPORT_DAYS} days of from` }],
    });
  }
  const events = await new Repo(c.env.DB).statusEventsUntil(endOfDay(query.to), query.rescueId);
  const body: DailyAvailabilityReport = {
    from: query.from,
    to: query.to,
    rescueId: query.rescueId ?? null,
    items: dailyAvailability(events, query.from, query.to),
  };
  return c.json(body);
});

const endOfDay = (date: string) => `${date}T23:59:59.999Z`;

/** Calendar days from `from` to `to`, both included. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Replays status events in time order. For each UTC day in [from, to] the
 * count is the number of dogs whose latest status as of the end of that
 * day is `available`. Events are already filtered to <= end of `to`.
 */
export function dailyAvailability(events: StatusEventRow[], from: string, to: string): { date: string; availableCount: number }[] {
  const latest = new Map<string, string>();
  let available = 0;
  let i = 0;
  const items: { date: string; availableCount: number }[] = [];
  for (let day = new Date(`${from}T00:00:00.000Z`); day.toISOString().slice(0, 10) <= to; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const cutoff = endOfDay(date);
    for (; i < events.length && events[i]!.effective_at <= cutoff; i++) {
      const e = events[i]!;
      const previous = latest.get(e.dog_id);
      if (previous === 'available') available--;
      if (e.status === 'available') available++;
      latest.set(e.dog_id, e.status);
    }
    items.push({ date, availableCount: available });
  }
  return items;
}
