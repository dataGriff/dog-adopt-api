import { Hono } from 'hono';
import { cors } from 'hono/cors';
import openapi from '@dogadopt/contracts/openapi.json';
import { ProblemError, problemResponse, type Health } from '@dogadopt/contracts';
import type { Env } from './env.js';
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

  app.notFound((c) => {
    const instance = new URL(c.req.url).pathname;
    return problemResponse('not_found', { detail: `No route for ${c.req.method} ${instance}`, instance });
  });
  app.onError((err, c) => {
    const instance = new URL(c.req.url).pathname;
    if (err instanceof ProblemError) return problemResponse(err.errorCode, { ...err.options, instance });
    console.error('unhandled error', err);
    return problemResponse('internal_error', { instance });
  });

  return app;
}
