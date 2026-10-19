import { describe, expect, it } from 'vitest';
import type { Problem } from '@dogadopt/contracts';
import { api, json } from './helpers.js';
import { daysInclusive, MAX_REPORT_DAYS } from '../src/routes/reports.js';

describe('Daily availability is bounded', () => {
  it('counts days inclusively', () => {
    expect(daysInclusive('2026-01-01', '2026-01-01')).toBe(1);
    expect(daysInclusive('2026-01-01', '2026-12-31')).toBe(365);
    expect(daysInclusive('2024-01-01', '2024-12-31')).toBe(366);
  });
  it('A 400-day range is rejected naming `to`', async () => {
    const res = await api('/v1/reports/daily-availability?from=2025-01-01&to=2026-02-05');
    expect(res.status).toBe(400);
    const problem = await json<Problem>(res);
    expect(problem.errorCode).toBe('validation_failed');
    expect(problem.errors?.map((e) => e.path)).toContain('to');
    expect(daysInclusive('2025-01-01', '2026-02-05')).toBeGreaterThan(MAX_REPORT_DAYS);
  });
  it('A 366-day range is served', async () => {
    const res = await api('/v1/reports/daily-availability?from=2024-01-01&to=2024-12-31');
    expect(res.status).toBe(200);
    expect((await json<{ items: unknown[] }>(res)).items).toHaveLength(366);
  });
});
