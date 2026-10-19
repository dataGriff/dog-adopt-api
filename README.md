# dog-adopt-api

The Dogs API: a Cloudflare Worker that serves dogs available for adoption at UK rescues and ingests the snapshots the finder captures from rescue websites. It is built against the contracts in [dog-adopt-spec](https://github.com/dataGriff/dog-adopt-spec); the OpenAPI, AsyncAPI, feature files and data contracts there are the record, and this code is wrong wherever it disagrees with them.

## How it is built

| Concern | Choice |
| --- | --- |
| Runtime | Cloudflare Workers, [Hono](https://hono.dev) |
| Storage | D1 (SQLite). Schema in `migrations/`, columns named as the data contracts name them |
| Validation | The zod schemas generated into `@dogadopt/contracts` from the OpenAPI. No schema is hand-written here |
| Events | `dogs.listed/updated/withdrawn.v1` CloudEvents to an optional Queue producer binding `DOG_EVENTS`. Without the binding nothing is emitted |
| Errors | RFC 9457 `application/problem+json` with the contract's `errorCode` values |
| Tests | Vitest running inside workerd (`@cloudflare/vitest-plugin`) against the migrated, seeded D1. One test per scenario in the feature files |

```
src/
  index.ts        worker entry
  app.ts          Hono app: CORS, routes, problem+json error handling, /openapi.json
  routes/         one file per tag: dogs, rescues, breeds, reports, ingest
  reconcile.ts    pure snapshot reconciliation (no I/O), the heart of ingest
  repo.ts         every D1 query
  mappers.ts      rows -> contract JSON
  problems.ts     ProblemError and problem responses
  validate.ts     parseOr400 / parseOr404 with the generated schemas
migrations/
  0001_schema.sql
  0002_seed_reference_data.sql   generated from the contracts' seed data (rescues, breeds, synonyms)
scripts/build-seed-migration.mjs
test/             contract, reconcile, browse-dogs (feature), ingest-snapshot (feature)
```

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars        # sets FINDER_TOKEN for local ingest calls
pnpm db:migrate:local                 # creates the local D1 and applies migrations + seed
pnpm dev                              # http://localhost:8787
```

Try it:

```sh
curl 'http://localhost:8787/v1/rescues?q=cardiff'
curl 'http://localhost:8787/v1/dogs?size=Small&goodWithCats=true'
curl http://localhost:8787/openapi.json | head
```

Post a snapshot for a rescue (take the rescue id from the call above; the key must be unique per snapshot):

```sh
curl -X POST "http://localhost:8787/v1/ingest/rescues/$RESCUE_ID/snapshots" \
  -H 'Authorization: Bearer local-dev-finder-token-change-me' \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "capturedAt": "2026-10-19T08:00:00Z",
    "source": { "adapter": "cardiff-dogs-home", "url": "https://www.cardiffdogshome.co.uk/give-a-dog-a-home/dogs-available-for-rehoming/", "mode": "fixture" },
    "complete": true,
    "dogs": [
      { "externalId": "bella-2", "name": "Bella", "age": "Adult", "size": "Medium", "gender": "Female", "breeds": ["Staffie"], "goodWithKids": true, "profileUrl": "https://www.cardiffdogshome.co.uk/dog/bella-2/" }
    ]
  }'
```

Posting the same body with the same key again returns the same result; a different body with the same key is a 409. A complete snapshot that omits a dog the finder listed earlier marks that dog `withdrawn`.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm test` applies the migrations to an in-memory D1 and runs:

- `test/contract.test.ts`: every operationId in the OpenAPI has a route, and nothing undeclared is routed.
- `test/browse-dogs.test.ts` and `test/ingest-snapshot.test.ts`: one test per scenario in the feature files, with every 200 response body validated against the generated response schema.
- `test/reconcile.test.ts`: the pure reconciliation plan.

## Configuration

`wrangler.jsonc`:

- `DB`: the D1 binding. Run `wrangler d1 create dogadopt` once and paste the id.
- `API_VERSION`, `CORS_ORIGINS` (comma separated; `*` for any).
- `DOG_EVENTS` queue producer: commented out. Create `dogadopt-dog-events` and uncomment to emit events.

Secrets (`wrangler secret put`):

- `FINDER_TOKEN`: the bearer token the finder sends on `/v1/ingest/*`. Compared in constant time.

## The contracts package

`package.json` pins `@dogadopt/contracts` to a git ref of dog-adopt-spec:

```json
"@dogadopt/contracts": "github:dataGriff/dog-adopt-spec#ccr-36d5f29f-ktwvoo"
```

To pick up a contract change: move the ref (a tag once released), `pnpm update @dogadopt/contracts`, `pnpm build:seed` if seed data changed, then run the checks. The package ships its built `dist/`, so no build step runs on install.

## Deploying

`.github/workflows/deploy.yml` applies migrations and deploys on pushes to `main` once the repository variable `CLOUDFLARE_DEPLOY_ENABLED` is `true` and the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist. Nothing is deployed from this repository until then.
