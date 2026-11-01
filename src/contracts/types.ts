// The frozen contract. A change needs a decision and a new numbered migration.
import type { FailedCode, SkippedCode } from './codes.ts';
export type * from './config.ts';

// ---- enums ----
export type Format = 'email'|'landing_page';  export type RunFormat = 'both'|Format;  export type Part = Format|'catalog';
export type Slot = 'p1'|'p2'|'p3'|'p4'|'p5'|'p6';
export type Shape = 'trip'|'gift'|'home'|'wedding'|'scene'|'open';  export type Group = 'wear'|'home';
export type Stage = 'voice'|'F'|'rehearsal'|'Haiku'|'isolation';
export type UnitStatus = 'pending'|'prepared'|'admitted'|'drafted'|'failed'|'skipped';
export type RunStatus = 'preparing'|'generating'|'done'|'stopped';
export type DraftStatus = 'draft'|'in_review'|'approved'|'rejected'|'released'|'failed';
export type ReasonCode = 'OCCASION_MATCH'|'SAME_CLASS_NEW'|'SAME_MATERIAL'|'TRIP_TAG'|'FALLBACK_NON_OCCASION'|'HAND_SET'|'NEW_USER_PRIOR';
export type ResultType = 'answered'|'refusal'|'possibly_billed'|'no_completion'|'invalid_request';
export type Signal = 'occasion'|'season_prior';
// FailedCode, SkippedCode in codes.ts = §9

// ---- catalogue ----
export interface Variant { id: string; sku: string|null; title: string; option1: string|null; option2: string|null;
  price: string /* internal only */; available: boolean }
export interface Image { src: string; src_canonical: string; position: number; variant_ids: string[] }
export interface Product { id: string; handle: string; title: string; url: string; body_text_clean: string|null;
  category: string[]; subcategory: string[]; class: string[]; subclass: string[]; wear_occasion: string[];
  gift_occasion: string[]; gift_recipient: string[]; line: string[]; room_or_use: string[]; collection: string[];
  campaign: string[]; occasion_keys: string[]; prior_tags: string[]; material: string|null; material_group: string|null;
  colours: string[]; gender: 'female'|'male'|'any'|null; design_group: string|null; badges: string[];
  is_bestseller_gift: boolean; available: boolean; variants: Variant[]; images: Image[];
  excluded_reason: string|null; content_sha256: string;
  excluded_reasons?: string[] /* every rule it fails, first = excluded_reason */; published_at?: string|null;
  push_down?: boolean /* the site's push_down tag; absent on a snapshot built before R138 */; merch_rank?: Record<string, number> /* 1-based position in each site collection that holds it, R140 */; facets?: Record<string, string[]> /* filter values by family, R141; absent before that */ }
export interface Rules { title_cores: string[]; distinctive_cores: string[]; nouns: string[]; handles: string[] }
export interface Catalog { snapshot_id: string; fetched_at: string; rows: Map<string,Product>; by_sku: Map<string,string>;
  usable: Product[]; rules: Rules }
export interface MapRow { kind: 'occasion'|'recipient'|'price_tag'|'line'|'ignored'; key?: string; recipient?: string; why?: string }
export interface OccasionMap { version: string; default: MapRow; quote_labels: Record<string,string[]>;
  values: Record<string,Record<string,MapRow>> }

// ---- inputs ----
// note_words: lowercase words of the note, only to test a past_purchase label. plan.ts reads them and never copies them onto Plan (R123).
export interface Customer { customer_id: string; first_name: string|null; occasion: string|null; new_user: boolean; note_words?: string[] }
export type IngestResult = { key: string; status: 'ok'; record: Customer }
                  | { key: string; status: 'invalid'|'duplicate'; errors: string[] };
export interface RecPick { product_id: string; reason_code: ReasonCode; why?: string[]; score?: number }   // why: signal names (R127), shown to a reviewer, never to the model
export type MoreKind = 'occasion'|'occasion_category'|'past_purchase';
export interface MoreSection { kind: MoreKind; label: string; product_ids: string[]; why?: Record<string,string[]> }   // why by product id
export interface Weights { occasion: number; season: number; bestseller: number; new: number; past: number; merchandising?: number; push_down?: number }   // push_down is a penalty; a version saved before R138 or R140 lacks that key and ranks at 0 for it
export interface PoolCounts { filtered: number; on_occasion: number; past: number }   // how many products passed the filter, and how many of those carry each signal
export interface WriteBy { model: string|null; setting: string|null; prompt_version: string|null; prompt_sha256: string|null; prompt_files: string[]; schema: string|null; attempt: number; request_sha256: string|null;
  tokens: { input: number|null; output: number|null; cached: number|null; cache_written: number|null }; stop_reason: string|null; cost: number|null; written_by_model: string[]; written_by_code: string[] }
export interface CheckBy { validator_version: string|null; ran: number; failed: number }
export interface JudgeBy { model: string|null; config_version: string|null; questions: string[]; gate: number|null; flagged: string[]; can_block: false }
export interface GeneratedBy { ranking: RankingBy|null; write: WriteBy|null; checks: CheckBy|null; judge: JudgeBy|null }   // read from stored rows; a value nobody stored is null
export interface RankingBy { method: 'tiers'|'weights'; version: string; weights: Weights; rules: string[]; snapshot_id: string; cost: 0; catalog_version?: string; queries?: { model: string; prompt_sha256: string; date: string } }
export interface RecRow { customer_id: string; picks: RecPick[]; more?: MoreSection[]; pool?: PoolCounts }
export interface RecFile { version: 'recommendations/v1'; synthetic: boolean; as_of: string; snapshot_id: string; rule: string; rows: RecRow[]; generated_by?: RankingBy }
export type RowKeys = Record<string, { key: string|null }>;   // data/row_keys.synthetic.json, §3 spec
export interface ShapesFile { version: string; default: 'open'; shapes: { id: Shape; re: string; flags: string; job: string }[] }

// ---- plan ----
export interface Pick { slot: Slot; product_id: string; reason_code: ReasonCode; group: Group; why?: string[]; score?: number }
export interface Pinned { snapshot_id: string; customers_sha256: string; recs_sha256: string; shapes_sha256: string; run_date: string;
  prompt_version: string; voice_guide_version: string; jev_model: string; jev_config_version: string; format: RunFormat }
export interface Admission { setting: string; input_tokens: number; est_1_usd: number; commit_usd: number;
  action: 'admit'|'skip'|'stop'; code?: SkippedCode }
export interface PlanMore { kind: MoreKind; heading: string; product_ids: string[]; why?: Record<string,string[]> }   // absent on a plan with none, and on every plan stored before R123
export interface Plan { run_id: string; customer_id: string; created_at: string; pinned: Pinned;
  display_name: string|null; occasion: string|null; occasion_key: string|null; shape: Shape|null; new_user: boolean;
  format: RunFormat; picks: Pick[]; more?: PlanMore[]; pool?: PoolCounts; generated_by?: { ranking: RankingBy }; signals: Signal[]; admission: Admission|null;
  outcome: {kind:'ready'}|{kind:'failed';code:FailedCode}|{kind:'skipped';code:SkippedCode} }
// signals, set only when new_user: 'occasion' if occasion is non-null; 'season_prior' if any pick is NEW_USER_PRIOR.

// ---- generate ----
export interface Rung { id: string; model: string; thinking: {type:'between_tools'|'disabled'}|null; effort: 'low'|'medium'|'high'|null;
  max_tokens: Record<RunFormat,number>; passed: Partial<Record<RunFormat,boolean>> }
export interface AnthropicRequest { model: string; max_tokens: number; system: unknown[]; messages: unknown[]; thinking?: unknown;
  output_config: { effort?: string; format: { type:'json_schema'; schema: object } } }
export interface Envelope { customer_id: string; display_name: string|null; run_id: string; format: RunFormat; picks: {slot: Slot; product_id: string}[];
  occasion_key: string|null; shape: Shape|null; snapshot_id: string; snapshot_fetched_at: string; model: string; setting: string;
  prompt_version: string; voice_guide_version: string; validator_version: string;
  carried_from: 1|null; carried_part: Format|null }
export type ModelDraft = Record<string,unknown>;
export interface ModelJson { email?: ModelDraft; landing_page?: ModelDraft; unparsed?: string }   // the only stored shape, §4
export interface ExpandedDraft { part: Format; schema: 'email/v2'|'landing/v3'; model: ModelDraft; reader_text: string;
  fields: { name: string; raw: string; expanded: string; slot_scope: Slot[]|null }[] }
export interface RenderedJson { email: string|null; landing_page: string|null; catalog: string }   // null only under runs.format
export interface CheckResult { id: string; part: Part; severity: 'hard'|'warn'|'advisory'; pass: boolean; code?: string; field?: string; detail?: string }
export interface DraftRow { id: string; run_id: string; customer_id: string; version: 1|2; format: RunFormat; snapshot_id: string;
  validator_version: string; model: string; envelope_json: string; model_json: string; rendered_json: string;
  content_sha256: string; checks_json: string; hard_failures: number }

// ---- cost ----
export interface Prices { as_of: string; billed_refusal_categories: string[];
  models: Record<string,{ in: number; out: number; write_5m: number; read: number }> }
export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export interface Estimate { key: string; format: RunFormat; rung: string; input_tokens: number }
export interface CapConfig { sha256: string; S: Record<RunFormat,number>; U_design_max: Record<RunFormat,number>; U_hard: Record<RunFormat,number>;
  E_out: Record<string,Record<RunFormat,number>>; measured: boolean }
export interface AdmissionResult { per: Record<string,Admission>; admitted: {key: string; format: RunFormat}[]; committed_usd: number }
export interface PlanPreview { customers_sha256: string; recs_sha256: string; snapshot_id: string; prompt_version: string; prompt_sha256: string; format: RunFormat;
  start_rung: string; cap_sha256: string; jev_reserve_usd: number; sum_commit_usd: number; plans: Plan[] }
export type StagesFile = Record<Stage,{ expected_usd: number; runs: number }>;
export interface BrandLine { id: string; text: string; source: string; fetched_at: string }
export interface QuotesFile { version: string; quotes: { id: string; text: string; slug: string; source: string; fetched_at: string; labels: string[] }[];
  brand_lines: { default: string; keys: Record<string,string>; lines: BrandLine[] } }
export interface PriorTagsFile { tags: string[] }
export interface SeasonFile { as_of: string; excluded_subcategories: string[] }

// ---- state ----
export interface Guarded { stmt: D1PreparedStatement; expectOne: boolean }
export type Edge = 'E2'|'E3'|'E4'|'E5'|'E6'|'E7';
export type EdgeResult = { ok: true; status: DraftStatus }
  | { ok: false; http: 400|409; code: 'WRONG_STATE'|'HASH_MISMATCH'|'CHECKS_FAILED'|'STALE_PICK'|'SNAPSHOT_TOO_OLD'; detail?: object };
export type Freshness = { ok: true; snapshot_id: string; age_s: number } | { ok: false; code: 'SNAPSHOT_TOO_OLD'; age_s: number }
  | { ok: false; code: 'STALE_PICK'; product_id: string; reason: 'gone'|'unavailable'|'image_gone'|'title_changed' };
export interface RunReport { run_id: string; stage: Stage; format: RunFormat; status: RunStatus; counts: Record<string,number>;
  first_try_pass: Record<Format,number>; retry_cause: Record<Format,Record<string,number>>; carried_parts: number;
  jev_fallbacks: Record<string,number>; est_usd: number; spent_usd: number; jev_usd: number; cap_run_usd: number; ceiling_usd: number;
  cache_hit_rate: number; recs_sha256: string; run_date: string; snapshot_fetched_at: string; fresh_for_release_h: number; placeholders: string[] }
export type Actor = {kind:'system'} | {kind:'human'; email: string; sub: string} | {kind:'dev'; email: string; sub: string};   // sub = 'dev:<email>'

// ---- jev ----
export type JevStatus = 'answered'|'below_gate'|'unavailable'|'model_mismatch'|'skipped_reserve';
export interface JevSide { what: string; examples: string[] }
export type JevQuestion = { type:'noul'; instructions: string; criteria: {true: JevSide; false: JevSide}; bad: boolean }
                 | { type:'score'; instructions: string; criteria: string[]; bad: 'lowest' };
export interface JevConfig { version: string; model: string; deadline_ms: number; flag_gate: number; score_flag_confidence: number;
  basis_usd: number; act_gate: number; act: Record<string,false>; j3: Record<string,JevQuestion> }
export interface J3Input { email: string|null; landing_page: string|null; quote: string|null; picks: {title: string; facets: string[]}[];
  occasion: string|null; occasion_key: string|null; new_user: boolean }
export interface JevOutcome { status: JevStatus; reason: string|null; model: string|null; answers: Record<string,unknown>|null;
  input_tokens: number|null; charged_usd: number|null; basis_usd: number }

// ---- worker env: vars and secrets ----
// Env comes from `wrangler types`. DEV_* and secrets are absent from wrangler.jsonc on purpose.
export type AppEnv = Env & { DEV_MODE?: string; DEV_ACTOR?: string; DEV_FAULT?: string; ACCESS_AUD?: string; PUBLIC_DEMO?: string;
  ANTHROPIC_API_KEY?: string; ANTHROPIC_BASE_URL?: string; JEV_API_KEY?: string; RUN_KEY?: string; PUBLIC_ORIGIN?: string };
