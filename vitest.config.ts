import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  const seedSql = await readFile(path.join(import.meta.dirname, 'seed', 'reference-data.sql'), 'utf8');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, TEST_SEED_SQL: seedSql, FINDER_TOKEN: 'test-finder-token' },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      // One shared D1 per run; files and tests run one at a time.
      fileParallelism: false,
    },
  };
});
