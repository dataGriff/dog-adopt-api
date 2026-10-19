// All D1 access. Column names follow the data contracts; everything that
// leaves this module is a row type from ./types or a plain value.
import { ENQUIRABLE_STATUSES, type DogStatus, type SnapshotResult } from '@dogadopt/contracts';
import type { ReconcilePlan } from './reconcile.js';
import type { DogBreed, DogRow, DogWithBreeds, RescueRow } from './types.js';

/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 90;

export interface DogListFilters {
  statuses: readonly DogStatus[];
  size?: string;
  age?: string;
  gender?: string;
  breed?: string;
  rescueId?: string;
  region?: string;
  goodWithKids?: boolean;
  goodWithDogs?: boolean;
  goodWithCats?: boolean;
  q?: string;
}

export interface DogListedRow extends DogRow {
  rescue_name: string;
  rescue_region: string;
  rescue_website: string | null;
  rescue_latitude: number | null;
  rescue_longitude: number | null;
}

export interface DogListedWithBreeds extends DogListedRow {
  breeds: DogBreed[];
}

export interface RescueListFilters {
  region?: string;
  q?: string;
  hasDogs?: boolean;
}

export interface RescueWithCount extends RescueRow {
  dog_count: number;
}

export interface StatusEventRow {
  dog_id: string;
  status: DogStatus;
  effective_at: string;
}

export interface SnapshotRow {
  id: string;
  rescue_id: string;
  idempotency_key: string;
  body_hash: string;
  result: string;
}

const EFFECTIVE_AGE_SQL = `CASE WHEN d.birth_year IS NULL THEN d.age ELSE
  CASE
    WHEN (julianday(?) - julianday(printf('%04d-%02d-%02d', d.birth_year, COALESCE(d.birth_month, 7), COALESCE(d.birth_day, 1)))) / 365.25 < 1 THEN 'Puppy'
    WHEN (julianday(?) - julianday(printf('%04d-%02d-%02d', d.birth_year, COALESCE(d.birth_month, 7), COALESCE(d.birth_day, 1)))) / 365.25 < 3 THEN 'Young'
    WHEN (julianday(?) - julianday(printf('%04d-%02d-%02d', d.birth_year, COALESCE(d.birth_month, 7), COALESCE(d.birth_day, 1)))) / 365.25 < 8 THEN 'Adult'
    ELSE 'Senior'
  END END`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ----- rescues -----------------------------------------------------------

  async getRescue(id: string): Promise<RescueWithCount | null> {
    return this.db
      .prepare(`SELECT r.*, ${this.dogCountSql()} AS dog_count FROM rescues r WHERE r.id = ?`)
      .bind(id)
      .first<RescueWithCount>();
  }

  async rescueExists(id: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT 1 AS one FROM rescues WHERE id = ?').bind(id).first<{ one: number }>();
    return row !== null;
  }

  async listRescues(filters: RescueListFilters, page: number, pageSize: number): Promise<{ items: RescueWithCount[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.region) { where.push('r.region = ?'); params.push(filters.region); }
    if (filters.q) { where.push(`r.name LIKE ? ESCAPE '\\' COLLATE NOCASE`); params.push(`%${escapeLike(filters.q)}%`); }
    if (filters.hasDogs === true) where.push(`${this.dogCountSql()} > 0`);
    if (filters.hasDogs === false) where.push(`${this.dogCountSql()} = 0`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [count, rows] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) AS n FROM rescues r ${whereSql}`).bind(...params).first<{ n: number }>(),
      this.db
        .prepare(`SELECT r.*, ${this.dogCountSql()} AS dog_count FROM rescues r ${whereSql} ORDER BY r.name COLLATE NOCASE ASC, r.id ASC LIMIT ? OFFSET ?`)
        .bind(...params, pageSize, (page - 1) * pageSize)
        .all<RescueWithCount>(),
    ]);
    return { items: rows.results, total: count?.n ?? 0 };
  }

  private dogCountSql(): string {
    return `(SELECT COUNT(*) FROM dogs d WHERE d.rescue_id = r.id AND d.status IN (${ENQUIRABLE_STATUSES.map((s) => `'${s}'`).join(', ')}))`;
  }

  // ----- dogs --------------------------------------------------------------

  async getDog(id: string, now: Date): Promise<DogListedWithBreeds | null> {
    const row = await this.db
      .prepare(`${this.dogSelectSql()} WHERE d.id = ?`)
      .bind(id)
      .first<DogListedRow>();
    if (!row) return null;
    void now;
    const breeds = await this.breedsFor([id]);
    return { ...row, breeds: breeds.get(id) ?? [] };
  }

  /** Filtered dogs, newest first. With `unbounded` every match is returned (used for distance ordering). */
  async listDogs(filters: DogListFilters, now: Date, paging: { page: number; pageSize: number } | null): Promise<{ items: DogListedWithBreeds[]; total: number }> {
    const { whereSql, params } = this.dogWhere(filters, now);
    const order = 'ORDER BY d.created_at DESC, d.id DESC';
    const [count, rows] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) AS n FROM dogs d JOIN rescues r ON r.id = d.rescue_id ${whereSql}`).bind(...params).first<{ n: number }>(),
      paging
        ? this.db.prepare(`${this.dogSelectSql()} ${whereSql} ${order} LIMIT ? OFFSET ?`).bind(...params, paging.pageSize, (paging.page - 1) * paging.pageSize).all<DogListedRow>()
        : this.db.prepare(`${this.dogSelectSql()} ${whereSql} ${order}`).bind(...params).all<DogListedRow>(),
    ]);
    const breeds = await this.breedsFor(rows.results.map((r) => r.id));
    return { items: rows.results.map((r) => ({ ...r, breeds: breeds.get(r.id) ?? [] })), total: count?.n ?? 0 };
  }

  private dogSelectSql(): string {
    return `SELECT d.*, r.name AS rescue_name, r.region AS rescue_region, r.website AS rescue_website, r.latitude AS rescue_latitude, r.longitude AS rescue_longitude
      FROM dogs d JOIN rescues r ON r.id = d.rescue_id`;
  }

  private dogWhere(f: DogListFilters, now: Date): { whereSql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    where.push(`d.status IN (${f.statuses.map(() => '?').join(', ')})`);
    params.push(...f.statuses);
    if (f.size) { where.push('d.size = ?'); params.push(f.size); }
    if (f.gender) { where.push('d.gender = ?'); params.push(f.gender); }
    if (f.age) { where.push(`(${EFFECTIVE_AGE_SQL}) = ?`); const iso = now.toISOString(); params.push(iso, iso, iso, f.age); }
    if (f.rescueId) { where.push('d.rescue_id = ?'); params.push(f.rescueId); }
    if (f.region) { where.push('r.region = ?'); params.push(f.region); }
    if (f.goodWithKids !== undefined) { where.push('d.good_with_kids = ?'); params.push(f.goodWithKids ? 1 : 0); }
    if (f.goodWithDogs !== undefined) { where.push('d.good_with_dogs = ?'); params.push(f.goodWithDogs ? 1 : 0); }
    if (f.goodWithCats !== undefined) { where.push('d.good_with_cats = ?'); params.push(f.goodWithCats ? 1 : 0); }
    if (f.breed) { where.push('EXISTS (SELECT 1 FROM dog_breeds b WHERE b.dog_id = d.id AND b.breed_name = ? COLLATE NOCASE)'); params.push(f.breed); }
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`;
      where.push(`(d.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR EXISTS (SELECT 1 FROM dog_breeds b WHERE b.dog_id = d.id AND (b.breed_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR b.unresolved_name LIKE ? ESCAPE '\\' COLLATE NOCASE)))`);
      params.push(like, like, like);
    }
    return { whereSql: `WHERE ${where.join(' AND ')}`, params };
  }

  async breedsFor(dogIds: string[]): Promise<Map<string, DogBreed[]>> {
    const out = new Map<string, DogBreed[]>();
    for (let i = 0; i < dogIds.length; i += MAX_PARAMS) {
      const chunk = dogIds.slice(i, i + MAX_PARAMS);
      const rows = await this.db
        .prepare(`SELECT dog_id, display_order, breed_name, unresolved_name FROM dog_breeds WHERE dog_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY dog_id, display_order`)
        .bind(...chunk)
        .all<{ dog_id: string; display_order: number; breed_name: string | null; unresolved_name: string | null }>();
      for (const r of rows.results) {
        const list = out.get(r.dog_id) ?? [];
        list.push({ displayOrder: r.display_order, breedName: r.breed_name, unresolvedName: r.unresolved_name });
        out.set(r.dog_id, list);
      }
    }
    return out;
  }

  /** Every dog of a rescue, any status, with breeds. Used by reconciliation. */
  async dogsOfRescue(rescueId: string): Promise<DogWithBreeds[]> {
    const rows = await this.db.prepare('SELECT * FROM dogs WHERE rescue_id = ?').bind(rescueId).all<DogRow>();
    const breeds = await this.breedsFor(rows.results.map((r) => r.id));
    return rows.results.map((r) => ({ ...r, breeds: breeds.get(r.id) ?? [] }));
  }

  // ----- breeds ------------------------------------------------------------

  async listBreeds(): Promise<{ name: string; synonyms: string[] }[]> {
    const [breeds, synonyms] = await Promise.all([
      this.db.prepare('SELECT name FROM breeds ORDER BY name COLLATE NOCASE').all<{ name: string }>(),
      this.db.prepare('SELECT synonym, breed_name FROM breed_synonyms ORDER BY synonym COLLATE NOCASE').all<{ synonym: string; breed_name: string }>(),
    ]);
    const byBreed = new Map<string, string[]>();
    for (const s of synonyms.results) byBreed.set(s.breed_name, [...(byBreed.get(s.breed_name) ?? []), s.synonym]);
    return breeds.results.map((b) => ({ name: b.name, synonyms: byBreed.get(b.name) ?? [] }));
  }

  /** Case-insensitive map of canonical names and synonyms to canonical names. */
  async breedResolver(): Promise<{ resolve(name: string): string | null }> {
    const breeds = await this.listBreeds();
    const index = new Map<string, string>();
    for (const b of breeds) {
      index.set(b.name.toLowerCase(), b.name);
      for (const s of b.synonyms) index.set(s.toLowerCase(), b.name);
    }
    return { resolve: (name) => index.get(name.trim().toLowerCase()) ?? null };
  }

  // ----- reports -----------------------------------------------------------

  async statusEventsUntil(untilIso: string, rescueId?: string): Promise<StatusEventRow[]> {
    const sql = `SELECT dog_id, status, effective_at FROM dog_status_events WHERE effective_at <= ? ${rescueId ? 'AND rescue_id = ?' : ''} ORDER BY effective_at ASC, id ASC`;
    const stmt = rescueId ? this.db.prepare(sql).bind(untilIso, rescueId) : this.db.prepare(sql).bind(untilIso);
    return (await stmt.all<StatusEventRow>()).results;
  }

  // ----- snapshots ---------------------------------------------------------

  async snapshotByKey(idempotencyKey: string): Promise<SnapshotRow | null> {
    return this.db.prepare('SELECT id, rescue_id, idempotency_key, body_hash, result FROM snapshots WHERE idempotency_key = ?').bind(idempotencyKey).first<SnapshotRow>();
  }

  async snapshotResult(rescueId: string, snapshotId: string): Promise<SnapshotResult | null> {
    const row = await this.db.prepare('SELECT result FROM snapshots WHERE id = ? AND rescue_id = ?').bind(snapshotId, rescueId).first<{ result: string }>();
    return row ? (JSON.parse(row.result) as SnapshotResult) : null;
  }

  /**
   * Applies a reconciliation plan. Each created or updated dog is its own
   * batch so one failure rejects that dog alone; touches, withdrawals and
   * the snapshot record go in a final batch.
   */
  async applyPlan(plan: ReconcilePlan, ctx: { rescueId: string; snapshotId: string; capturedAt: string; now: string }): Promise<{ rejected: { externalId: string; reason: string }[]; failedDogIds: Set<string> }> {
    const rejected = [...plan.rejected];
    const failedDogIds = new Set<string>();

    for (const c of plan.creates) {
      const stmts = [
        this.db
          .prepare(`INSERT INTO dogs (id, rescue_id, external_id, name, status, status_notes, age, birth_year, birth_month, birth_day, size, gender,
            good_with_kids, good_with_dogs, good_with_cats, image_url, profile_url, description, rescue_since_date, first_seen_at, last_seen_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
          .bind(c.id, ctx.rescueId, c.externalId, c.fields.name, c.fields.status, c.fields.age, c.fields.birth_year, c.fields.birth_month, c.fields.birth_day,
            c.fields.size, c.fields.gender, c.fields.good_with_kids, c.fields.good_with_dogs, c.fields.good_with_cats, c.fields.image_url, c.fields.profile_url,
            c.fields.rescue_since_date, ctx.capturedAt, ctx.capturedAt, ctx.now, ctx.now),
        ...this.breedInserts(c.id, c.breeds),
        this.statusEventInsert(c.id, ctx.rescueId, c.fields.status, ctx.capturedAt, ctx.snapshotId),
      ];
      try {
        await this.db.batch(stmts);
      } catch (err) {
        rejected.push({ externalId: c.externalId, reason: errorMessage(err) });
        failedDogIds.add(c.id);
      }
    }

    for (const u of plan.updates) {
      const stmts = [
        this.db
          .prepare(`UPDATE dogs SET name = ?, status = ?, age = ?, birth_year = ?, birth_month = ?, birth_day = ?, size = ?, gender = ?,
            good_with_kids = ?, good_with_dogs = ?, good_with_cats = ?, image_url = ?, profile_url = ?, rescue_since_date = ?,
            last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`)
          .bind(u.fields.name, u.fields.status, u.fields.age, u.fields.birth_year, u.fields.birth_month, u.fields.birth_day, u.fields.size, u.fields.gender,
            u.fields.good_with_kids, u.fields.good_with_dogs, u.fields.good_with_cats, u.fields.image_url, u.fields.profile_url, u.fields.rescue_since_date,
            ctx.capturedAt, ctx.now, u.id),
        this.db.prepare('DELETE FROM dog_breeds WHERE dog_id = ?').bind(u.id),
        ...this.breedInserts(u.id, u.breeds),
        ...(u.statusChanged ? [this.statusEventInsert(u.id, ctx.rescueId, u.fields.status, ctx.capturedAt, ctx.snapshotId)] : []),
      ];
      try {
        await this.db.batch(stmts);
      } catch (err) {
        rejected.push({ externalId: u.externalId, reason: errorMessage(err) });
        failedDogIds.add(u.id);
      }
    }

    const tail: D1PreparedStatement[] = [];
    for (const id of plan.touches) {
      tail.push(this.db.prepare('UPDATE dogs SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?').bind(ctx.capturedAt, id));
    }
    for (const w of plan.withdrawals) {
      tail.push(this.db.prepare(`UPDATE dogs SET status = 'withdrawn', updated_at = ? WHERE id = ?`).bind(ctx.now, w.id));
      tail.push(this.statusEventInsert(w.id, ctx.rescueId, 'withdrawn', ctx.capturedAt, ctx.snapshotId));
    }
    if (tail.length) await this.db.batch(tail);

    return { rejected, failedDogIds };
  }

  async recordSnapshot(row: { id: string; rescueId: string; idempotencyKey: string; bodyHash: string; capturedAt: string; processedAt: string; adapter: string; mode: string; complete: boolean; result: SnapshotResult }): Promise<void> {
    await this.db
      .prepare('INSERT INTO snapshots (id, rescue_id, idempotency_key, body_hash, captured_at, processed_at, adapter, mode, complete, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.rescueId, row.idempotencyKey, row.bodyHash, row.capturedAt, row.processedAt, row.adapter, row.mode, row.complete ? 1 : 0, JSON.stringify(row.result))
      .run();
  }

  private breedInserts(dogId: string, breeds: DogBreed[]): D1PreparedStatement[] {
    return breeds.map((b) =>
      this.db.prepare('INSERT INTO dog_breeds (dog_id, display_order, breed_name, unresolved_name) VALUES (?, ?, ?, ?)').bind(dogId, b.displayOrder, b.breedName, b.unresolvedName),
    );
  }

  private statusEventInsert(dogId: string, rescueId: string, status: string, effectiveAt: string, snapshotId: string | null): D1PreparedStatement {
    return this.db.prepare('INSERT INTO dog_status_events (dog_id, rescue_id, status, effective_at, snapshot_id) VALUES (?, ?, ?, ?, ?)').bind(dogId, rescueId, status, effectiveAt, snapshotId);
  }

  // ----- test and admin helpers -------------------------------------------

  /** Inserts a hand-entered or finder-managed dog directly. Used by tests and future admin tooling. */
  async insertDog(row: DogRow, breeds: DogBreed[], statusEffectiveAt: string = row.created_at): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO dogs (id, rescue_id, external_id, name, status, status_notes, age, birth_year, birth_month, birth_day, size, gender,
          good_with_kids, good_with_dogs, good_with_cats, image_url, profile_url, description, rescue_since_date, first_seen_at, last_seen_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, row.rescue_id, row.external_id, row.name, row.status, row.status_notes, row.age, row.birth_year, row.birth_month, row.birth_day, row.size, row.gender,
          row.good_with_kids, row.good_with_dogs, row.good_with_cats, row.image_url, row.profile_url, row.description, row.rescue_since_date, row.first_seen_at, row.last_seen_at, row.created_at, row.updated_at),
      ...this.breedInserts(row.id, breeds),
      this.statusEventInsert(row.id, row.rescue_id, row.status, statusEffectiveAt, null),
    ]);
  }

  async insertRescue(row: RescueRow): Promise<void> {
    await this.db
      .prepare(`INSERT INTO rescues (id, name, type, region, website, phone, email, address, postcode, charity_number, contact_notes, latitude, longitude, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.name, row.type, row.region, row.website, row.phone, row.email, row.address, row.postcode, row.charity_number, row.contact_notes, row.latitude, row.longitude, row.created_at, row.updated_at)
      .run();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
