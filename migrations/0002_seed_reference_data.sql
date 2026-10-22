-- Reference data (rescues, breeds, synonyms) used to live in this migration.
-- A migration runs once per database, so a seed change would never reach a
-- database that had already applied it. The seed is now the idempotent
-- seed/reference-data.sql, applied with `pnpm db:seed:local` /
-- `pnpm db:seed:remote` after every migration run. This file is kept so the
-- migration sequence stays valid for databases that already recorded it.
SELECT 1;
