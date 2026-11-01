-- Ranking weights join config_versions as kind 'rank'. SQLite cannot widen a CHECK, so the table is rebuilt; nothing references it.
CREATE TABLE config_versions_new (
  id TEXT PRIMARY KEY,                     -- 'v1', 'v2'; 'jev-v1'; 'rank-v1'. Allocated by saveVersion
  kind TEXT NOT NULL CHECK (kind IN ('prompt','jev','rank')),
  parent_id TEXT NULL,
  content_json TEXT NOT NULL,              -- canonicalContent(PromptFiles|JevConfig|Weights)
  sha256 TEXT NOT NULL,                    -- sha256(content_json)
  base_sha256 TEXT NOT NULL,               -- prompt: bundled schemas; jev: locked fields of config/jev.json; rank: a constant
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
INSERT INTO config_versions_new SELECT id, kind, parent_id, content_json, sha256, base_sha256, voice_guide_version, status, note, created_kind, created_by, created_sub, created_at, activated_by, activated_sub, activated_at, validation_json FROM config_versions;
DROP TABLE config_versions;
ALTER TABLE config_versions_new RENAME TO config_versions;
CREATE UNIQUE INDEX one_active ON config_versions(kind) WHERE status = 'active';
CREATE TRIGGER rank_immutable BEFORE UPDATE OF content_json, sha256 ON config_versions WHEN OLD.kind = 'rank'
  BEGIN SELECT RAISE(ABORT, 'a rank version is immutable'); END;

-- The ranking a run was built with. NULL on older rows and on a recommendations file with no version.
ALTER TABLE runs ADD COLUMN ranking_version TEXT NULL;
