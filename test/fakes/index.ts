// Fake `Lib` for every 46 §6 signature except node-only readPromptDir, keyed by fixture. Lanes code against this until the owner merges.
// Keys: fx-both, fx-email, fx-newuser, fx-retry, fx-throw, row:3. An unknown key throws.
import fixture from '../fixtures/catalog.fixture.json' with { type: 'json' };
import good from '../fixtures/drafts.good.json' with { type: 'json' };
import type { Lib } from '../../src/contracts/lib.ts';
import type { Catalog, CheckResult, ConfigVersion, DraftRow, DraftStatus, Edge, EdgeResult, Envelope, Format, IngestResult, ModelJson, Pinned, Plan,
  JevConfig, Product, PromptFiles, RunFormat, RunReport, Slot } from '../../src/contracts/types.ts';

export const FX_KEYS = ['fx-both', 'fx-email', 'fx-newuser', 'fx-retry', 'fx-throw', 'row:3'] as const;
export type FxKey = (typeof FX_KEYS)[number];
export const FX_RUN = 'fx-run';

const FORMATS: Record<FxKey, RunFormat> = { 'fx-both': 'both', 'fx-email': 'email', 'fx-newuser': 'both', 'fx-retry': 'both',
  'fx-throw': 'both', 'row:3': 'both' };
const known = (k: string): FxKey => {
  if (!(FX_KEYS as readonly string[]).includes(k)) throw new Error(`no fake for key ${k}`);
  return k as FxKey;
};
const parts = (f: RunFormat): Format[] => (f === 'both' ? ['email', 'landing_page'] : [f]);

export function fxCatalog(): Catalog {
  const usable = fixture.rows as unknown as Product[];
  return { snapshot_id: fixture.snapshot_id, fetched_at: fixture.fetched_at, usable,
    rows: new Map(usable.map((p) => [p.id, p])),
    by_sku: new Map(usable.flatMap((p) => p.variants.filter((v) => v.sku).map((v) => [v.sku as string, p.id] as [string, string]))),
    rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: usable.map((p) => p.handle) } };
}

export const fxPinned: Pinned = { snapshot_id: fixture.snapshot_id, customers_sha256: 'fx', recs_sha256: 'fx', shapes_sha256: 'fx',
  run_date: '2026-11-01', prompt_version: 'v1', voice_guide_version: 'v1', jev_model: 'jev-1.14.0', jev_config_version: 'jev-v1', format: 'both' };

export function fxPlan(key: string): Plan {
  const k = known(key);
  const failed = k === 'row:3';
  const count = FORMATS[k] === 'email' ? 3 : 4;
  const picks = failed ? [] : fxCatalog().usable.slice(0, count).map((p, i) => ({ slot: `p${i + 1}` as Slot, product_id: p.id,
    reason_code: k === 'fx-newuser' ? 'NEW_USER_PRIOR' as const : 'OCCASION_MATCH' as const, group: 'wear' as const }));
  const new_user = k === 'fx-newuser';
  return { run_id: FX_RUN, customer_id: k, created_at: '2026-11-01T00:00:00Z', pinned: { ...fxPinned, format: FORMATS[k] },
    display_name: failed ? null : 'Fixture', occasion: failed ? null : 'Diwali at home', occasion_key: failed ? null : 'diwali',
    shape: failed ? null : 'home', new_user, format: FORMATS[k], picks, signals: new_user ? ['occasion', 'season_prior'] : [], admission: null,
    outcome: failed ? { kind: 'failed', code: 'INVALID_CUSTOMER' } : { kind: 'ready' } };
}

export function fxEnvelope(key: string, n: 1 | 2 = 1): Envelope {
  const p = fxPlan(key);
  return { customer_id: p.customer_id, display_name: p.display_name, run_id: FX_RUN, format: p.format, picks: p.picks.map(({ slot, product_id }) => ({ slot, product_id })),
    occasion_key: p.occasion_key, shape: p.shape, snapshot_id: fixture.snapshot_id, snapshot_fetched_at: fixture.fetched_at,
    model: 'claude-sonnet-5-5', setting: 'sonnet-between_tools', prompt_version: 'v1', voice_guide_version: 'v1', validator_version: 'fx',
    carried_from: n === 2 ? 1 : null, carried_part: null };
}

export function fxModelJson(key: string): ModelJson {
  const pick = (part: Format) => good.drafts.find((d) => part in d.draft)?.draft as ModelJson;
  return Object.assign({}, ...parts(FORMATS[known(key)]).map(pick));
}

const stmt = {} as D1PreparedStatement;   // fakes never execute

const EDGES: Record<Edge, { from: DraftStatus; to: DraftStatus }> = { E2: { from: 'draft', to: 'in_review' }, E3: { from: 'draft', to: 'failed' },
  E4: { from: 'in_review', to: 'approved' }, E5: { from: 'in_review', to: 'rejected' }, E6: { from: 'approved', to: 'in_review' },
  E7: { from: 'approved', to: 'released' } };
/** Draft states for the fake `transition`. Reset between tests with `.clear()`; unseen drafts start at `in_review`. */
export const fxDraftStates = new Map<string, DraftStatus>();

export const fxPrompt: PromptFiles = { role: 'role', voice_card: 'voice', email: 'email', landing: 'landing', task: 'task', retry: 'retry' };
export const fxJev: JevConfig = { version: 'jev-v1', model: 'jev-1.14.0', deadline_ms: 20000, flag_gate: 0.5, score_flag_confidence: 0.6,
  basis_usd: 0.000554, act_gate: 0.9, act: { discount: false }, j3: { discount: { type: 'noul', instructions: 'fake',
    criteria: { true: { what: 'yes', examples: ['a'] }, false: { what: 'no', examples: ['b'] } }, bad: true } } };
const fxVersion = (id: string, kind: 'prompt' | 'jev'): ConfigVersion => ({ id, kind, parent_id: null, content: kind === 'prompt' ? fxPrompt : fxJev,
  sha256: 'fx', base_sha256: 'fx', voice_guide_version: kind === 'prompt' ? id : null, status: 'active', note: 'fx', created_by: 'fx', created_at: '2026-11-01T00:00:00Z',
  activated_by: 'fx', activated_at: '2026-11-01T00:00:00Z' });

export function fxReport(run_id = FX_RUN): RunReport {
  return { run_id, stage: 'isolation', format: 'both', status: 'done', counts: { 'unit:drafted': 4, 'unit:failed': 2, 'code:INVALID_CUSTOMER': 1,
    'code:INTERNAL_ERROR': 1, 'draft:in_review': 4 }, first_try_pass: { email: 3, landing_page: 3 }, retry_cause: { email: { C3: 1 }, landing_page: {} },
    carried_parts: 1, jev_fallbacks: {}, est_usd: 0, spent_usd: 0, jev_usd: 0, cap_run_usd: 1, ceiling_usd: 1, cache_hit_rate: 0, recs_sha256: 'fx',
    run_date: '2026-11-01', snapshot_fetched_at: fixture.fetched_at, fresh_for_release_h: 8760, placeholders: [] };
}

const hardFail = (part: Format): CheckResult => ({ id: 'C3', part, severity: 'hard', pass: false, code: 'OVER_WORDS', detail: 'fake' });
const page = (part: string, slots: string[]) => `<article data-part="${part}">${slots.map((s) =>
  `<img data-slot="${s}" src="https://cdn.shopify.com/fx/${s}.jpg?v=1" alt="${s}">`).join('')}</article>`;

export const fakeLib: Lib = {
  ingestTsv: () => FX_KEYS.map((key): IngestResult => key === 'row:3'
    ? { key, status: 'invalid', errors: ['field count'] }
    : { key, status: 'ok', record: { customer_id: key, first_name: 'Fixture', occasion: 'Diwali at home', new_user: key === 'fx-newuser' } }),
  parseRecs: (json) => json as ReturnType<Lib['parseRecs']>,
  parseRowKeys: (json) => json as ReturnType<Lib['parseRowKeys']>,
  loadCatalog: async () => fxCatalog(),
  computeShape: (occasion) => (occasion ? 'home' : 'open'),
  planCustomer: (item) => fxPlan(item.key),
  assemblePrefix: (files) => Object.values(files).join('\n'),
  renderSuffix: (plan, _cat, files) => `${files.task}:${plan.customer_id}`,
  canonicalContent: (c) => JSON.stringify(c).replaceAll('\\r\\n', '\\n'),
  buildRequest: (plan, _pinned, _cat, rung) => ({ model: rung.model, max_tokens: rung.max_tokens[plan.format], system: [],
    messages: [{ role: 'user', content: plan.customer_id }], output_config: { format: { type: 'json_schema', schema: {} } } }),
  shapeOnly: (schema) => schema,
  toModelJson: (text, wanted, carried) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text); } catch { return { unparsed: text }; }
    const out: ModelJson = wanted.length === 1 && !(wanted[0] in parsed) ? { [wanted[0]]: parsed } : parsed;
    return carried ? { ...out, [carried.part]: carried.model } : out;
  },
  validate: (_json, envelope) => {
    if (envelope.customer_id === 'fx-retry' && envelope.carried_from === null) return [hardFail('email')];
    return parts(envelope.format).map((part) => ({ id: 'C1', part, severity: 'hard', pass: true }));
  },
  expand: (model, part) => ({ part, schema: part === 'email' ? 'email/v2' : 'landing/v3', model, reader_text: JSON.stringify(model), fields: [] }),
  renderEmail: (_d, _cat, env) => page('email', env.picks.map((p) => p.slot)),
  renderLanding: (_d, _cat, env) => page('landing_page', env.picks.map((p) => p.slot)),
  renderCatalog: (plan) => page('catalog', plan.picks.map((p) => p.slot)),
  renderAll: (m, plan, env, cat) => ({
    email: m.email ? fakeLib.renderEmail(fakeLib.expand(m.email, 'email', env, cat), cat, env) : null,
    landing_page: m.landing_page ? fakeLib.renderLanding(fakeLib.expand(m.landing_page, 'landing_page', env, cat), cat, env) : null,
    catalog: fakeLib.renderCatalog(plan, cat) }),
  imagePaths: () => ({ p1: '/fx/p1.jpg' }),
  runBatch: async () => {},
  moveUnit: () => ({ stmt, expectOne: true }),
  insertDraft: () => ({ stmt, expectOne: true }),
  transition: async (_env, draft_id, edge): Promise<EdgeResult> => {
    const now = fxDraftStates.get(draft_id) ?? 'in_review';
    if (now !== EDGES[edge].from) return { ok: false, http: 409, code: 'WRONG_STATE' };
    fxDraftStates.set(draft_id, EDGES[edge].to);
    return { ok: true, status: EDGES[edge].to };
  },
  freshness: (env) => ({ ok: true, snapshot_id: env.snapshot_id, age_s: 0 }),
  runReport: async (_db, run_id) => fxReport(run_id),
  finish: async (_env, _run, key, n) => {
    if (known(key) === 'fx-throw') throw new Error('fx-throw');
    return { retry: key === 'fx-retry' && n === 1 };
  },
  failUnit: async () => {},
  callWorst: (input, max, format, cap, prices) => {
    const model = Object.values(prices.models)[0];
    return ((input + cap.S[format]) * model.in + max * model.out) / 1e6;
  },
  admitAll: (estimates) => ({ committed_usd: 0, admitted: estimates.map(({ key, format }) => ({ key, format })),
    per: Object.fromEntries(estimates.map((e) => [e.key, { setting: e.rung, input_tokens: e.input_tokens, est_1_usd: 0, commit_usd: 0, action: 'admit' as const }])) }),
  capRun: (preview) => ({ ceiling_usd: preview.sum_commit_usd, cap_run_usd: preview.sum_commit_usd }),
  retryGate: async () => true,
  settle: () => [],
  j3Input: (d: DraftRow, plan) => ({ email: null, landing_page: null, quote: null, picks: [], occasion: plan.occasion, occasion_key: plan.occasion_key, new_user: plan.new_user }),
  judgeDraft: async (_env, _input, cfg) => ({ status: 'answered', reason: null, model: cfg.model, answers: {}, input_tokens: 100, charged_usd: cfg.basis_usd, basis_usd: cfg.basis_usd }),
  flaggedQuestions: (answers) => Object.keys(answers),
  jevPreflight: async () => ({ ok: true }),
  jevReserveOk: async () => true,
  activeVersions: async () => ({ prompt: fxVersion('v1', 'prompt'), jev: fxVersion('jev-v1', 'jev') }),
  loadVersion: async (_db, id) => fxVersion(id, id.startsWith('jev-') ? 'jev' : 'prompt'),
  validatePrompt: () => ({ ok: true, prefix_bytes: 13000 }),
  validateJev: () => ({ ok: true }),
  saveVersion: async (_db, kind, parent_id, content, note, actor) => ({ ...fxVersion(kind === 'jev' ? 'jev-v2' : 'v2', kind === 'rank' || kind === 'catalog' ? 'jev' : kind), parent_id, content, note,
    status: 'draft', created_by: actor.kind === 'system' ? 'system' : actor.email, activated_by: null, activated_at: null }),
  activateVersion: async (_db, id) => fxVersion(id, id.startsWith('jev-') ? 'jev' : 'prompt'),
  lineDiff: (a, b) => (a === b ? [{ op: '=', text: a }] : [{ op: '-', text: a }, { op: '+', text: b }]),
  dismissFlag: async () => {},
  reviewFlags: async () => [{ question: 'discount', flagged: true, dismissal: null }],
  flagRow: (f) => `<tr><td>${f.question}</td></tr>`,
  evalValidity: async () => [{ goal: 10, kind: 'prompt', active_id: 'v1', stages: ['F'], run_ids: [], state: 'no_run_yet' }],
};
