import { env } from 'cloudflare:test';
import type { IngestRescueSnapshotBody, AgeCategory, DogSize, DogStatus, Gender, SnapshotResult } from '@dogadopt/contracts';
import type { z } from 'zod';
import { createApp } from '../src/app.js';
import { Repo } from '../src/repo.js';
import type { DogBreed, DogRow, RescueRow } from '../src/types.js';

export const app = createApp();
export const repo = () => new Repo(env.DB);
export const TOKEN = 'test-finder-token';

export interface FakeQueue extends Queue {
  sent: unknown[];
}

export function fakeQueue(): FakeQueue {
  const sent: unknown[] = [];
  return {
    sent,
    async send(body: unknown) { sent.push(body); },
    async sendBatch(messages: Iterable<{ body: unknown }>) { for (const m of messages) sent.push(m.body); },
  } as unknown as FakeQueue;
}

export async function api(path: string, init: RequestInit = {}, overrides: Partial<typeof env> = {}): Promise<Response> {
  return app.request(`http://api.test${path}`, init, { ...env, ...overrides });
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export const daysAgo = (n: number, base: Date = new Date()) => new Date(base.getTime() - n * 24 * 60 * 60 * 1000);
export const iso = (d: Date) => d.toISOString();
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

export async function rescueByName(name: string): Promise<RescueRow> {
  const row = await env.DB.prepare('SELECT * FROM rescues WHERE name = ?').bind(name).first<RescueRow>();
  if (!row) throw new Error(`no rescue named ${name}`);
  return row;
}

export async function setCoordinates(name: string, latitude: number | null, longitude: number | null): Promise<void> {
  await env.DB.prepare('UPDATE rescues SET latitude = ?, longitude = ? WHERE name = ?').bind(latitude, longitude, name).run();
}

export async function insertRescue(name: string, region = 'Test Region', latitude: number | null = null, longitude: number | null = null): Promise<RescueRow> {
  const now = iso(new Date());
  const row: RescueRow = {
    id: crypto.randomUUID(), name, type: 'Full', region, website: null, phone: null, email: null, address: null, postcode: null,
    charity_number: null, contact_notes: null, latitude, longitude, created_at: now, updated_at: now,
  };
  await repo().insertRescue(row);
  return row;
}

export interface DogSpec {
  name: string;
  status?: DogStatus;
  age?: AgeCategory;
  size?: DogSize;
  gender?: Gender;
  breeds?: string[];
  unresolvedBreeds?: string[];
  goodWithKids?: boolean | null;
  goodWithDogs?: boolean | null;
  goodWithCats?: boolean | null;
  externalId?: string | null;
  birthYear?: number | null;
  birthMonth?: number | null;
  /** When the dog's status took effect (and first/last seen). Defaults to now. */
  since?: Date;
  lastSeenAt?: Date;
  profileUrl?: string | null;
  imageUrl?: string | null;
}

const toInt = (v: boolean | null | undefined) => (v === true ? 1 : v === false ? 0 : null);

export async function insertDog(rescue: RescueRow, spec: DogSpec): Promise<DogRow> {
  const since = spec.since ?? new Date();
  const row: DogRow = {
    id: crypto.randomUUID(),
    rescue_id: rescue.id,
    external_id: spec.externalId === undefined ? `${spec.name.toLowerCase().replace(/\s+/g, '-')}-${rescue.id.slice(0, 4)}` : spec.externalId,
    name: spec.name,
    status: spec.status ?? 'available',
    status_notes: null,
    age: spec.age ?? 'Adult',
    birth_year: spec.birthYear ?? null,
    birth_month: spec.birthMonth ?? null,
    birth_day: null,
    size: spec.size ?? 'Medium',
    gender: spec.gender ?? 'Female',
    good_with_kids: toInt(spec.goodWithKids),
    good_with_dogs: toInt(spec.goodWithDogs),
    good_with_cats: toInt(spec.goodWithCats),
    image_url: spec.imageUrl ?? null,
    profile_url: spec.profileUrl ?? null,
    description: null,
    rescue_since_date: null,
    first_seen_at: iso(since),
    last_seen_at: iso(spec.lastSeenAt ?? since),
    created_at: iso(since),
    updated_at: iso(since),
  };
  const breeds: DogBreed[] = [
    ...(spec.breeds ?? []).map((b, i) => ({ displayOrder: i + 1, breedName: b, unresolvedName: null })),
    ...(spec.unresolvedBreeds ?? []).map((b, i) => ({ displayOrder: (spec.breeds?.length ?? 0) + i + 1, breedName: null, unresolvedName: b })),
  ];
  await repo().insertDog(row, breeds, iso(since));
  return row;
}

export type SnapshotInput = z.input<typeof IngestRescueSnapshotBody>;
export type FoundDogInput = SnapshotInput['dogs'][number];

export function found(name: string, externalId: string, extra: Partial<FoundDogInput> = {}): FoundDogInput {
  return { externalId, name, age: 'Adult', size: 'Medium', gender: 'Female', breeds: ['Staffordshire Bull Terrier'], ...extra };
}

export function snapshot(dogs: FoundDogInput[], extra: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    capturedAt: iso(new Date()),
    source: { adapter: 'cardiff-dogs-home', url: 'https://www.cardiffdogshome.co.uk/give-a-dog-a-home/dogs-available-for-rehoming/', mode: 'fixture' },
    complete: true,
    dogs,
    ...extra,
  };
}

export interface IngestOptions {
  key?: string;
  token?: string | null;
  queue?: FakeQueue;
  rawBody?: string;
  noKey?: boolean;
}

export async function ingest(rescueId: string, body: unknown, opts: IngestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? TOKEN}`;
  if (!opts.noKey) headers['idempotency-key'] = opts.key ?? crypto.randomUUID();
  return api(`/v1/ingest/rescues/${rescueId}/snapshots`, { method: 'POST', headers, body: opts.rawBody ?? JSON.stringify(body) }, opts.queue ? { DOG_EVENTS: opts.queue } : {});
}

export async function ingestOk(rescueId: string, body: unknown, opts: IngestOptions = {}): Promise<SnapshotResult> {
  const res = await ingest(rescueId, body, opts);
  if (res.status !== 200) throw new Error(`ingest failed ${res.status}: ${await res.text()}`);
  return json<SnapshotResult>(res);
}

export async function dogRow(id: string): Promise<DogRow> {
  const row = await env.DB.prepare('SELECT * FROM dogs WHERE id = ?').bind(id).first<DogRow>();
  if (!row) throw new Error(`no dog ${id}`);
  return row;
}

export async function dogByExternalId(rescueId: string, externalId: string): Promise<DogRow> {
  const row = await env.DB.prepare('SELECT * FROM dogs WHERE rescue_id = ? AND external_id = ?').bind(rescueId, externalId).first<DogRow>();
  if (!row) throw new Error(`no dog ${externalId} at ${rescueId}`);
  return row;
}
