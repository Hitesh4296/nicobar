CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,                     -- 'v1', 'v2'; 'jev-v1', 'jev-v2'. Allocated by saveVersion
  kind TEXT NOT NULL CHECK (kind IN ('prompt','jev')),
  parent_id TEXT NULL,
  content_json TEXT NOT NULL,              -- canonicalContent(PromptFiles|JevConfig)
  sha256 TEXT NOT NULL,                    -- sha256(content_json)
  base_sha256 TEXT NOT NULL,               -- prompt: bundled schemas; jev: locked fields of config/jev.json
  voice_guide_version TEXT NULL,           -- id of the version that last changed voice_card
  status TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_kind TEXT NOT NULL CHECK (created_kind IN ('human','dev')),
  created_by TEXT NOT NULL, created_sub TEXT NOT NULL, created_at TEXT NOT NULL,
  activated_by TEXT NULL, activated_sub TEXT NULL, activated_at TEXT NULL,
  validation_json TEXT NULL,               -- the passing result, written on activation
  CHECK ((kind = 'prompt') = (voice_guide_version IS NOT NULL)),
  CHECK ((status = 'draft') = (activated_by IS NULL)),
  CHECK ((activated_by IS NULL) = (activated_sub IS NULL AND activated_at IS NULL AND validation_json IS NULL)));
CREATE UNIQUE INDEX one_active ON config_versions(kind) WHERE status = 'active';

CREATE TABLE jev_dismissals (             -- not draft_events: a dismissal is not an edge
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt IN (1,2)),
  question TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','dev')),
  actor_email TEXT NOT NULL, actor_sub TEXT NOT NULL, at TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  PRIMARY KEY (run_id, customer_id, attempt, question));
