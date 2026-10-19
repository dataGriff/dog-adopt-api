import { Hono } from 'hono';
import { cors } from 'hono/cors';
import openapi from '@dogadopt/contracts/openapi.json';
import type { Health } from '@dogadopt/contracts';
import type { Env } from './env.js';
import { ProblemError, problemResponse } from './problems.js';
import { breeds } from './routes/breeds.js';
import { dogs } from './routes/dogs.js';
import { ingest } from './routes/ingest.js';
import { reports } from './routes/reports.js';
import { rescues } from './routes/rescues.js';

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const origins = (c.env.CORS_ORIGINS ?? '*').split(',').map((o) => o.trim()).filter(Boolean);
    const handler = cors({
      origin: origins.includes('*') ? '*' : origins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      maxAge: 86400,
    });
    return handler(c, next);
  });

  app.get('/v1/health', (c) => {
    const body: Health = { status: 'ok', version: c.env.API_VERSION };
    return c.json(body);
  });
  app.get('/openapi.json', (c) => c.json(openapi));

  app.route('/', dogs);
  app.route('/', rescues);
  app.route('/', breeds);
  app.route('/', reports);
  app.route('/', ingest);

  app.notFound((c) => problemResponse('not_found', `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, undefined, new URL(c.req.url).pathname));
  app.onError((err, c) => {
    if (err instanceof ProblemError) return problemResponse(err.errorCode, err.detail, err.errors, new URL(c.req.url).pathname);
    console.error('unhandled error', err);
    return problemResponse('internal_error', undefined, undefined, new URL(c.req.url).pathname);
  });

  return app;
}
