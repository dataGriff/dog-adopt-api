-- Dogs API schema. Column names, types and conventions follow the data
-- contracts in dog-adopt-spec/services/dogs-api/data-contracts:
-- booleans are integers (1/0/null), dates and timestamps are ISO-8601 text.

CREATE TABLE rescues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('Full', 'Provisional')),
  region TEXT NOT NULL,
  website TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  postcode TEXT,
  charity_number TEXT,
  contact_notes TEXT,
  latitude REAL CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
  longitude REAL CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rescues_region ON rescues (region);

CREATE TABLE breeds (
  name TEXT PRIMARY KEY
);

CREATE TABLE breed_synonyms (
  synonym TEXT PRIMARY KEY COLLATE NOCASE,
  breed_name TEXT NOT NULL REFERENCES breeds (name)
);

CREATE TABLE dogs (
  id TEXT PRIMARY KEY,
  rescue_id TEXT NOT NULL REFERENCES rescues (id),
  external_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'fostered', 'on_hold', 'adopted', 'withdrawn')),
  status_notes TEXT,
  age TEXT NOT NULL CHECK (age IN ('Puppy', 'Young', 'Adult', 'Senior')),
  birth_year INTEGER,
  birth_month INTEGER,
  birth_day INTEGER,
  size TEXT NOT NULL CHECK (size IN ('Small', 'Medium', 'Large')),
  gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female')),
  good_with_kids INTEGER CHECK (good_with_kids IN (0, 1)),
  good_with_dogs INTEGER CHECK (good_with_dogs IN (0, 1)),
  good_with_cats INTEGER CHECK (good_with_cats IN (0, 1)),
  image_url TEXT,
  profile_url TEXT,
  description TEXT,
  rescue_since_date TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- NULL external_id (hand-entered dogs) is allowed many times; SQLite treats NULLs as distinct.
  UNIQUE (rescue_id, external_id)
);
CREATE INDEX idx_dogs_rescue_status ON dogs (rescue_id, status);
CREATE INDEX idx_dogs_status_created ON dogs (status, created_at DESC);

CREATE TABLE dog_breeds (
  dog_id TEXT NOT NULL REFERENCES dogs (id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL CHECK (display_order >= 1),
  breed_name TEXT REFERENCES breeds (name),
  unresolved_name TEXT,
  PRIMARY KEY (dog_id, display_order),
  CHECK ((breed_name IS NULL) <> (unresolved_name IS NULL))
);
CREATE INDEX idx_dog_breeds_breed ON dog_breeds (breed_name);

CREATE TABLE dog_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dog_id TEXT NOT NULL REFERENCES dogs (id) ON DELETE CASCADE,
  rescue_id TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  snapshot_id TEXT
);
CREATE INDEX idx_dog_status_events_dog ON dog_status_events (dog_id, effective_at);
CREATE INDEX idx_dog_status_events_rescue ON dog_status_events (rescue_id, effective_at);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  rescue_id TEXT NOT NULL REFERENCES rescues (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  body_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  adapter TEXT NOT NULL,
  mode TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  result TEXT NOT NULL
);
CREATE INDEX idx_snapshots_rescue ON snapshots (rescue_id, processed_at DESC);
