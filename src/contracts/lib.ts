// Every library signature, once. `lib` binds them to the modules, so a module that drifts fails tsc;
// test/fakes implements the same `Lib`. `readPromptDir` is node-only, in scripts/prompt-dir.ts, and stays out.
import type { AdmissionResult, Actor, AnthropicRequest, AppEnv, CapConfig, Catalog, CheckResult, ConfigKind, ConfigVersion, DraftRow, Edge, EdgeResult,
  Envelope, EvalValidity, Estimate, ExpandedDraft, FlagView, Format, Freshness, Guarded, IngestResult, J3Input, JevConfig, JevOutcome, ModelDraft,
  ModelJson, Pinned, Plan, PlanPreview, Prices, PromptFiles, RecFile, RecRow, RenderedJson, RowKeys, RunFormat, RunReport, Rung, Shape,
  ShapesFile, UnitStatus, Usage, ValidationResult } from './types.ts';
import { ingestTsv } from '../lib/ingest.ts';
import { parseRecs, parseRowKeys } from '../lib/recs.ts';
import { loadCatalog } from '../lib/catalog/index.ts';
import { computeShape } from '../lib/shape.ts';
import { planCustomer } from '../lib/plan.ts';
import { assemblePrefix, buildRequest, renderSuffix, shapeOnly, toModelJson } from '../lib/gen/index.ts';
import { canonicalContent } from '../lib/gen/canonical.ts';
import { validate } from '../lib/check/index.ts';
import { expand } from '../lib/render/expand.ts';
import { renderEmail } from '../lib/render/email.ts';
import { renderLanding } from '../lib/render/landing-v2.ts';
import { renderCatalog } from '../lib/render/catalog.ts';
import { imagePaths, renderAll } from '../lib/render/index.ts';
import { freshness, insertDraft, moveUnit, runBatch, runReport, transition } from '../lib/state/index.ts';
import { finish, failUnit } from '../workflow/steps.ts';
import { admitAll, callWorst, capRun, retryGate, settle } from '../lib/cost/index.ts';
import { flaggedQuestions, j3Input, jevPreflight, jevReserveOk, judgeDraft } from '../lib/jev/index.ts';
import { activateVersion, activeVersions, dismissFlag, evalValidity, lineDiff, loadVersion, reviewFlags, saveVersion, validateJev,
  validatePrompt } from '../lib/config/index.ts';
import { flagRow } from '../ui/agents/index.ts';

type Db = D1Database;
export interface Lib {
  ingestTsv(text: string): IngestResult[];
  parseRecs(json: unknown): RecFile;
  parseRowKeys(json: unknown): RowKeys;
  loadCatalog(env: AppEnv, snapshot_id: string): Promise<Catalog>;
  computeShape(occasion: string | null, s: ShapesFile): Shape;
  planCustomer(item: IngestResult, rec: RecRow | null, keys: RowKeys, cat: Catalog, pinned: Pinned, s: ShapesFile): Plan;
  assemblePrefix(files: PromptFiles, schemas: object[]): string;
  renderSuffix(plan: Plan, cat: Catalog, files: PromptFiles, retry?: { failed: Format[]; checks: CheckResult[] }): string;
  canonicalContent(c: PromptFiles | JevConfig): string;
  buildRequest(plan: Plan, pinned: Pinned, cat: Catalog, rung: Rung, prompt: PromptFiles, retry?: { failed: Format[]; checks: CheckResult[] }): AnthropicRequest;
  shapeOnly(fullSchema: object): object;
  toModelJson(text: string, parts: Format[], carried?: { part: Format; model: ModelDraft }): ModelJson;
  validate(model_json: string, envelope: Envelope, cat: Catalog, plan: Plan): CheckResult[];
  expand(model: ModelDraft, part: Format, envelope: Envelope, cat: Catalog): ExpandedDraft;
  renderEmail(d: ExpandedDraft, cat: Catalog, envelope: Envelope): string;
  renderLanding(d: ExpandedDraft, cat: Catalog, envelope: Envelope): string;
  renderCatalog(plan: Plan, cat: Catalog): string;
  renderAll(m: ModelJson, plan: Plan, envelope: Envelope, cat: Catalog): RenderedJson;
  imagePaths(r: RenderedJson): Record<string, string>;
  runBatch(db: Db, items: Guarded[]): Promise<void>;
  moveUnit(db: Db, run_id: string, key: string, from: UnitStatus, to: UnitStatus,
    opts?: { code?: string; detail?: string; nonce?: { draft_id: string; n: string } }): Guarded;
  insertDraft(db: Db, row: DraftRow): Guarded;
  transition(env: AppEnv, draft_id: string, edge: Edge, actor: Actor, opts?: { note?: string }): Promise<EdgeResult>;
  freshness(envelope: Envelope, rendered_paths: Record<string, string>, newest: Catalog, fetched_at: string, now: number, max_age_h: number): Freshness;
  runReport(db: Db, run_id: string): Promise<RunReport>;
  finish(env: AppEnv, run_id: string, key: string, n: 1 | 2): Promise<{ retry: boolean }>;
  failUnit(env: AppEnv, run_id: string, key: string, e: unknown): Promise<void>;
  callWorst(input_tokens: number, max_tokens: number, format: RunFormat, cap: CapConfig, prices: Prices): number;
  admitAll(estimates: Estimate[], cap: CapConfig, rungs: Rung[], start: string, budget_usd: number | null, prices: Prices): AdmissionResult;
  capRun(preview: PlanPreview): { ceiling_usd: number; cap_run_usd: number };
  retryGate(db: Db, run_id: string, key: string, est_retry_usd: number): Promise<boolean>;
  settle(db: Db, run_id: string, key: string, attempt: number,
    msg: { usage: Usage; stop_reason?: string; category?: string | null; content_empty: boolean }, prices: Prices): Guarded[];
  j3Input(d: DraftRow, plan: Plan, cat: Catalog): J3Input;
  judgeDraft(env: AppEnv, input: J3Input, cfg: JevConfig): Promise<JevOutcome>;
  flaggedQuestions(answers: Record<string, unknown>, cfg: JevConfig): string[];
  jevPreflight(env: AppEnv, cfg: JevConfig): Promise<{ ok: true } | { ok: false; reason: string }>;
  jevReserveOk(db: Db, basis_usd: number): Promise<boolean>;
  activeVersions(db: Db): Promise<{ prompt: ConfigVersion; jev: ConfigVersion }>;
  loadVersion(db: Db, id: string, bundle: { schemas: object[]; jevBase: JevConfig }): Promise<ConfigVersion>;
  validatePrompt(files: PromptFiles, schemas: object[], fixture: Plan, cat: Catalog): ValidationResult;
  validateJev(next: JevConfig, base: JevConfig): ValidationResult;
  saveVersion(db: Db, kind: ConfigKind, parent_id: string | null, content: PromptFiles | JevConfig, note: string, actor: Actor): Promise<ConfigVersion>;
  activateVersion(db: Db, id: string, actor: Actor): Promise<ConfigVersion>;
  lineDiff(a: string, b: string): { op: '=' | '+' | '-'; text: string }[];
  dismissFlag(env: AppEnv, draft_id: string, question: string, note: string, actor: Actor): Promise<void>;
  reviewFlags(env: AppEnv, draft_id: string): Promise<FlagView[]>;
  flagRow(f: FlagView): string;
  evalValidity(db: Db): Promise<EvalValidity[]>;
}

export const lib: Lib = { ingestTsv, parseRecs, parseRowKeys, loadCatalog, computeShape, planCustomer, assemblePrefix, renderSuffix, canonicalContent, buildRequest, shapeOnly,
  toModelJson, validate, expand, renderEmail, renderLanding, renderCatalog, renderAll, imagePaths, runBatch, moveUnit, insertDraft,
  transition, freshness, runReport, finish, failUnit, callWorst, admitAll, capRun, retryGate, settle, j3Input, judgeDraft, flaggedQuestions, jevPreflight,
  jevReserveOk, activeVersions, loadVersion, validatePrompt, validateJev, saveVersion, activateVersion, lineDiff, dismissFlag, reviewFlags, flagRow,
  evalValidity };

/** sha256(envelope_json ‖ 0x00 ‖ model_json ‖ 0x00 ‖ rendered_json), lowercase hex. The only place these bytes are built. */
export async function contentSha256(envelope_json: string, model_json: string, rendered_json: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${envelope_json}\0${model_json}\0${rendered_json}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
