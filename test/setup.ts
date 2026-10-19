import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Runs once per test file: migrate (idempotent) and seed the shared D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The plugin does not isolate storage between tests, so every test starts
// from the seeded reference data with nothing a previous test wrote.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dog_breeds'),
    env.DB.prepare('DELETE FROM dog_status_events'),
    env.DB.prepare('DELETE FROM snapshots'),
    env.DB.prepare('DELETE FROM dogs'),
    env.DB.prepare(`DELETE FROM rescues WHERE created_at > '2026-10-19T00:00:00.000Z'`),
  ]);
});
