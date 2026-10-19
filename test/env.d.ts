import type { Env as AppEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_SEED_SQL: string;
    }
  }
}

export {};
