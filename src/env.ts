export interface Env {
  DB: D1Database;
  /** Optional producer for dogs.* events. Absent means nothing is emitted. */
  DOG_EVENTS?: Queue;
  /** Secret: bearer token the finder presents on ingest calls. */
  FINDER_TOKEN?: string;
  API_VERSION: string;
  CORS_ORIGINS?: string;
}
