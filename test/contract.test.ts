import { describe, expect, it } from 'vitest';
import openapi from '@dogadopt/contracts/openapi.json';
import { app } from './helpers.js';

// Every operation the contract declares is routed, and nothing else is
// (except the /openapi.json convenience and CORS preflight handling).
describe('routes match the OpenAPI document', () => {
  const declared = new Set<string>();
  for (const [path, item] of Object.entries(openapi.paths as Record<string, Record<string, unknown>>)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[method]) declared.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
  }
  const registered = new Set(
    app.routes
      .filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path !== '/openapi.json')
      .map((r) => `${r.method} ${r.path}`),
  );

  it('registers every operationId', () => {
    for (const route of declared) expect(registered, `missing ${route}`).toContain(route);
  });
  it('registers nothing the contract does not declare', () => {
    for (const route of registered) expect(declared, `undeclared ${route}`).toContain(route);
  });
  it('serves the bundled OpenAPI document', async () => {
    const res = await app.request('http://api.test/openapi.json', {}, { API_VERSION: 'test' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { info: { title: string } }).info.title).toBe('Dogs API');
  });
});
