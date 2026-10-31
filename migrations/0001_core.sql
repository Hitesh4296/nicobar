CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, product_rows INTEGER NOT NULL, usable_rows INTEGER NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)));

CREATE TABLE runs (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,        -- = id until a lost-state restart, §7
  stage TEXT NOT NULL CHECK (stage IN ('voice','F','rehearsal','Haiku','isolation')),
  format TEXT NOT NULL CHECK (format IN ('both','landing_page','email')),
  snapshot_id TEXT NOT NULL, run_date TEXT NOT NULL,
  customers_sha256 TEXT NOT NULL, customers_r2_key TEXT NOT NULL,
  customers_synthetic INTEGER NOT NULL CHECK (customers_synthetic IN (0,1)),
  recs_sha256 TEXT NOT NULL,
  setting TEXT NOT NULL, prompt_version TEXT NOT NULL, voice_guide_version TEXT NOT NULL,
  shapes_sha256 TEXT NOT NULL, season_excluded_json TEXT NULL,
  jev_model TEXT NOT NULL, jev_config_version TEXT NOT NULL,
  jev_reserve_usd REAL NOT NULL DEFAULT 0, jev_disabled_reason TEXT NULL,
  cap_run_usd REAL NOT NULL, ceiling_usd REAL NOT NULL, preview_sha256 TEXT NOT NULL,
  expected_usd REAL NOT NULL, committed_usd REAL NOT NULL DEFAULT 0,
  pool_usd REAL NOT NULL DEFAULT 0 CHECK (pool_usd >= 0), spent_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('preparing','generating','done','stopped')),
  stop_reason TEXT NULL, results_sha256 TEXT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK ((status = 'stopped') = (stop_reason IS NOT NULL)),
  CHECK (committed_usd <= cap_run_usd));

CREATE TABLE units (
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL,          -- may be 'row:<n>'
  status TEXT NOT NULL CHECK (status IN ('pending','prepared','admitted','drafted','failed','skipped')),
  code TEXT NULL, setting TEXT NULL,
  billed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (billed_attempts BETWEEN 0 AND 2),
  error_detail TEXT NULL,
  PRIMARY KEY (run_id, customer_id),
  CHECK ((status IN ('pending','prepared','admitted','drafted') AND code IS NULL)
    OR (status = 'failed' AND code IN ('COLD_START_NO_HISTORY','NO_RECOMMENDATION','INVALID_PICK','TOO_FEW_CANDIDATES',
        'INVALID_CUSTOMER','DUPLICATE_CUSTOMER_ID','CHECKS_FAILED','UPSTREAM_UNAVAILABLE','INVALID_REQUEST','INTERNAL_ERROR'))
    OR (status = 'skipped' AND code IN ('ESTIMATE_FAILED','OVER_CAP','RUN_CAP'))),
  CHECK (status <> 'skipped' OR billed_attempts = 0),
  CHECK (status <> 'drafted' OR billed_attempts >= 1));

CREATE TABLE plans (
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  plan_json TEXT NOT NULL, admission_json TEXT NULL,
  occasion_key TEXT NULL, shape TEXT NULL CHECK (shape IN ('trip','gift','home','wedding','scene','open')),
  new_user INTEGER NOT NULL DEFAULT 0 CHECK (new_user IN (0,1)),
  format TEXT NULL CHECK (format IN ('both','landing_page','email')),
  created_at TEXT NOT NULL, PRIMARY KEY (run_id, customer_id));

CREATE TABLE cost_events (                 -- as LLD:586, minus batch states
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt IN (1,2)),
  setting TEXT NOT NULL, input_tokens INTEGER NULL, est_usd REAL NULL, commit_usd REAL NULL,
  action TEXT NOT NULL CHECK (action IN ('admit','skip','stop','retry','retry_blocked')),
  call_state TEXT NOT NULL CHECK (call_state IN ('estimated','calling','answered','possibly_billed','unbilled','blocked')),
  charged_usd REAL NULL, reason TEXT NULL, request_sha256 TEXT NULL, at TEXT NOT NULL,
  PRIMARY KEY (run_id, customer_id, attempt),
  CHECK ((call_state IN ('answered','possibly_billed')) = (charged_usd IS NOT NULL)));

CREATE TABLE generations (
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  result_type TEXT NOT NULL CHECK (result_type IN ('answered','refusal','possibly_billed','no_completion','invalid_request')),
  stop_reason TEXT NULL, stop_detail TEXT NULL, message_json TEXT NULL, usage_json TEXT NULL,
  PRIMARY KEY (run_id, customer_id, attempt));

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,                     -- '<run_id>:<customer_id>:v<n>'
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version IN (1,2)),   -- = attempt
  format TEXT NOT NULL CHECK (format IN ('both','landing_page','email')),
  snapshot_id TEXT NOT NULL, validator_version TEXT NOT NULL, model TEXT NOT NULL,
  envelope_json TEXT NOT NULL, model_json TEXT NOT NULL /* untrusted */, rendered_json TEXT NOT NULL /* code-built, no prices */,
  content_sha256 TEXT NOT NULL,            -- sha256(envelope_json ‖ 0x00 ‖ model_json ‖ 0x00 ‖ rendered_json)
  checks_json TEXT NOT NULL, hard_failures INTEGER NOT NULL CHECK (hard_failures >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','approved','rejected','released','failed')),
  edge_nonce TEXT NULL,
  approved_by TEXT, approved_sub TEXT, approved_at TEXT, approved_sha256 TEXT,
  released_by TEXT, released_sub TEXT, released_at TEXT,
  UNIQUE (run_id, customer_id, version),
  CHECK (status NOT IN ('in_review','approved','released') OR hard_failures = 0),
  CHECK (status <> 'failed' OR hard_failures > 0),
  CHECK ((status IN ('approved','released')) = (approved_by IS NOT NULL AND approved_sub IS NOT NULL
                                               AND approved_at IS NOT NULL AND approved_sha256 IS NOT NULL)),
  CHECK ((status = 'released') = (released_by IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (status <> 'released' OR approved_sha256 = content_sha256));
CREATE UNIQUE INDEX one_live ON drafts(run_id, customer_id) WHERE status IN ('in_review','approved','released');

CREATE TABLE draft_events (               -- as LLD:645
  id INTEGER PRIMARY KEY, draft_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system','human','dev')),
  actor_email TEXT, actor_sub TEXT, at TEXT NOT NULL, content_sha256 TEXT NOT NULL, edge_nonce TEXT NOT NULL, note TEXT,
  evidence_json TEXT NULL,
  CHECK (to_status <> 'rejected' OR (note IS NOT NULL AND length(trim(note)) > 0)));

CREATE TABLE jev_events (
  run_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt IN (1,2)),
  model_requested TEXT NOT NULL, model_returned TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('answered','below_gate','unavailable','model_mismatch','skipped_reserve')),
  reason TEXT NULL, answers_json TEXT NULL, input_tokens INTEGER NULL, charged_usd REAL NULL,
  basis_usd REAL NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (run_id, customer_id, attempt),
  CHECK ((status = 'answered') = (reason IS NULL)),
  CHECK (status <> 'skipped_reserve' OR charged_usd IS NULL));

CREATE TABLE ledger_manual (id INTEGER PRIMARY KEY, at TEXT NOT NULL, item TEXT NOT NULL, usd REAL NOT NULL,
  note TEXT NOT NULL, actor_email TEXT NOT NULL);
