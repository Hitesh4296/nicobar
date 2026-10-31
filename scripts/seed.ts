// Local D1 only. `--fixtures`: a sample run to look at. `--voice <dir> [--catalog <file>]`: `draft-one` output, re-rendered and hashed,
// stage='voice', so the owner reads it on /review. Neither reaches the link: export-demo takes stage F and isolation only (46 §11).
import layout from '../test/cases/layout.json' with { type: 'json' };
import { fakeLib, fxCatalog, fxPinned } from '../test/fakes/index.ts';
import { contentSha256 } from '../src/contracts/lib.ts';
import { renderCatalog } from '../src/lib/render/catalog.ts';
import { renderAll } from '../src/lib/render/index.ts';
import { renderLanding } from '../src/lib/render/landing-v2.ts';
import type { Catalog, CheckResult, DraftStatus, Envelope, ExpandedDraft, Format, ModelDraft, ModelJson, Plan, Product, RenderedJson, RunFormat,
  Slot } from '../src/contracts/types.ts';

export interface VoiceFile { plan: Plan; envelope: Envelope; request_sha256: string; message: unknown; model_json: ModelJson | string; checks: CheckResult[] }
type Render = (m: ModelJson, plan: Plan, envelope: Envelope, cat: Catalog) => RenderedJson;
interface Item { plan: Plan; envelope: Envelope; model_json: string; rendered: RenderedJson; checks: CheckResult[]; status?: DraftStatus }

const AT = '2026-11-01T00:00:00Z';
const SEEDER = 'seed-demo@local';
export const FX_RUN_ID = 'fx-run';

const q = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`);
const insert = (table: string, row: Record<string, string | number | null>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')})`;
const partsOf = (f: RunFormat): Format[] => (f === 'both' ? ['email', 'landing_page'] : [f]);

function runSql(id: string, stage: 'voice' | 'rehearsal', format: RunFormat, snapshot_id: string, fetched_at: string): string[] {
  return [
    `DELETE FROM draft_events WHERE draft_id IN (SELECT id FROM drafts WHERE run_id = ${q(id)})`,
    ...['drafts', 'plans', 'units'].map((t) => `DELETE FROM ${t} WHERE run_id = ${q(id)}`),
    `DELETE FROM runs WHERE id = ${q(id)}`,
    insert('snapshots', { id: snapshot_id, fetched_at, product_rows: 0, usable_rows: 0 }).replace('INSERT', 'INSERT OR IGNORE'),
    insert('runs', { id, instance_id: id, stage, format, snapshot_id, run_date: AT.slice(0, 10), customers_sha256: 'seed', customers_r2_key: 'seed',
      customers_synthetic: 1, recs_sha256: 'seed', setting: 'seed', prompt_version: fxPinned.prompt_version, voice_guide_version: fxPinned.voice_guide_version,
      shapes_sha256: 'seed', jev_model: fxPinned.jev_model, jev_config_version: fxPinned.jev_config_version, cap_run_usd: 0, ceiling_usd: 0, preview_sha256: 'seed',
      expected_usd: 0, status: 'done', created_by: SEEDER, created_at: AT }),
  ];
}

async function itemSql(run_id: string, it: Item): Promise<string[]> {
  const { plan, envelope, model_json, rendered, checks } = it;
  const key = plan.customer_id;
  const hard_failures = checks.filter((c) => c.severity === 'hard' && !c.pass).length;
  const status = it.status ?? (hard_failures ? 'failed' : 'in_review');
  const id = `${run_id}:${key}:v1`;
  const envelope_json = JSON.stringify(envelope);
  const rendered_json = JSON.stringify(rendered);
  const content_sha256 = await contentSha256(envelope_json, model_json, rendered_json);
  const approved = status === 'approved' || status === 'released';
  const event = (n: number, from_status: string | null, to_status: string, kind: string, email: string | null) => insert('draft_events', { draft_id: id, from_status,
    to_status, actor_kind: kind, actor_email: email, actor_sub: email && `dev:${email}`, at: AT, content_sha256, edge_nonce: `seed-${n}`, note: null });
  return [
    insert('units', { run_id, customer_id: key, status: hard_failures ? 'failed' : 'drafted', code: hard_failures ? 'CHECKS_FAILED' : null, billed_attempts: 1 }),
    insert('plans', { run_id, customer_id: key, plan_json: JSON.stringify(plan), occasion_key: plan.occasion_key, shape: plan.shape, new_user: plan.new_user ? 1 : 0,
      format: plan.format, created_at: AT }),
    insert('drafts', { id, run_id, customer_id: key, version: 1, format: plan.format, snapshot_id: envelope.snapshot_id, validator_version: envelope.validator_version,
      model: envelope.model, envelope_json, model_json, rendered_json, content_sha256, checks_json: JSON.stringify(checks), hard_failures, status,
      approved_by: approved ? SEEDER : null, approved_sub: approved ? `dev:${SEEDER}` : null, approved_at: approved ? AT : null, approved_sha256: approved ? content_sha256 : null,
      released_by: status === 'released' ? SEEDER : null, released_sub: status === 'released' ? `dev:${SEEDER}` : null, released_at: status === 'released' ? AT : null }),
    event(1, 'draft', hard_failures ? 'failed' : 'in_review', 'system', null),
    ...(approved ? [event(2, 'in_review', 'approved', 'dev', SEEDER)] : []),
    ...(status === 'released' ? [event(3, 'approved', 'released', 'dev', SEEDER)] : []),
  ];
}

/** `draft-one`'s files, re-rendered by `renderAll`. `render` is a seam only for tests; `gen` and `page` supply the real one. */
export async function voiceSql(files: VoiceFile[], cat: Catalog, label: string, render: Render = renderAll): Promise<string[]> {
  const run_id = `voice-${label}`;
  const out = runSql(run_id, 'voice', files[0]?.plan.format ?? 'both', cat.snapshot_id, cat.fetched_at);
  for (const f of files) {
    const model = (typeof f.model_json === 'string' ? JSON.parse(f.model_json) : f.model_json) as ModelJson;
    const model_json = typeof f.model_json === 'string' ? f.model_json : JSON.stringify(f.model_json);
    const plan = { ...f.plan, run_id };
    const envelope = { ...f.envelope, run_id };
    out.push(...await itemSql(run_id, { plan, envelope, model_json, rendered: render(model, plan, envelope, cat), checks: f.checks }));
  }
  return out;
}

// ---- fixtures: real products, hand-written drafts from test/cases/layout.json ----
const NAMES: Record<string, string> = { c16: 'Aditi', c07: 'Sara', c02: 'Arjun', c18: 'Farhan' };
const casesById = new Map((layout.cases as unknown as { id: string }[]).map((c) => [c.id, c as Record<string, unknown>]));

export function fxCase(id: string, run_id = FX_RUN_ID): { plan: Plan; envelope: Envelope; model: ModelJson } {
  const c = casesById.get(id)!;
  const cat = fxCatalog();
  const byHandle = new Map(cat.usable.map((p) => [p.handle, p]));
  const new_user = c.new_user === true;
  const picks = (c.picks as string[]).map((h, i) => {
    const p = byHandle.get(h) as Product;
    return { slot: `p${i + 1}` as Slot, product_id: p.id, reason_code: new_user ? 'NEW_USER_PRIOR' as const : 'OCCASION_MATCH' as const,
      group: p.category.includes('House & Home') ? 'home' as const : 'wear' as const };
  });
  const customer_id = c.customer_id as string;
  const format = c.format as RunFormat;
  const occasion = (c.plan_occasion ?? null) as string | null;
  const occasion_key = (c.plan_occasion_key ?? null) as string | null;
  const shape = c.plan_shape as Plan['shape'];
  const plan: Plan = { run_id, customer_id, created_at: AT, pinned: { ...fxPinned, format }, display_name: NAMES[customer_id] ?? null, occasion, occasion_key, shape,
    new_user, format, picks, signals: new_user ? ['season_prior'] : [], admission: null, outcome: { kind: 'ready' } };
  const envelope: Envelope = { customer_id, display_name: plan.display_name, run_id, format, picks: picks.map(({ slot, product_id }) => ({ slot, product_id })), occasion_key, shape,
    snapshot_id: cat.snapshot_id, snapshot_fetched_at: cat.fetched_at, model: 'claude-sonnet-5-5', setting: 'fixture', prompt_version: 'v1', voice_guide_version: 'v1',
    validator_version: 'fixture', carried_from: null, carried_part: null };
  return { plan, envelope, model: c.draft as ModelJson };
}

/** `expand` for fixtures: gen's replaces this in real runs. Every string that holds a token gets a `fields` row. */
export function expandLanding(model: ModelDraft, envelope: Envelope, cat: Catalog): ExpandedDraft {
  const title = new Map(envelope.picks.map((p) => [p.slot, cat.rows.get(p.product_id)?.title ?? '']));
  const fields: ExpandedDraft['fields'] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && /\{p\d\}/.test(v)) fields.push({ name: 'text', raw: v, expanded: v.replace(/\{(p\d)\}/g, (_, s: Slot) => title.get(s) ?? ''), slot_scope: null });
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(model);
  return { part: 'landing_page', schema: 'landing/v3', model, reader_text: '', fields };
}

const passing = (f: RunFormat): CheckResult[] => [...partsOf(f), 'catalog' as const].flatMap((part) => (part === 'catalog' ? ['X1', 'X2', 'X3', 'X4'] : ['C1', 'C2', 'C3', 'C4', 'C8', 'C8n', 'X1', 'X2', 'X3', 'X4'])
  .map((id) => ({ id, part, severity: 'hard' as const, pass: true })));

export async function fixtureSql(): Promise<string[]> {
  const cat = fxCatalog();
  const out = runSql(FX_RUN_ID, 'rehearsal', 'landing_page', cat.snapshot_id, cat.fetched_at);
  const rows: [string, DraftStatus, CheckResult[]?][] = [['GOOD-c16', 'in_review'], ['GOOD-c07', 'approved'], ['GOOD-c02', 'released'], ['GOOD-c20', 'in_review'],
    ['GOOD-c18', 'failed', [{ id: 'C4', part: 'landing_page', severity: 'hard', pass: false, code: 'DISCOUNT', detail: 'fixture failure' }]]];
  for (const [id, status, checks] of rows) {
    const { plan, envelope, model } = fxCase(id);
    const landing_page = model.landing_page ? renderLanding(expandLanding(model.landing_page, envelope, cat), cat, envelope, plan) : null;
    // ponytail: fixture email is fake's stub until `gen` merges; these rows are landing_page format anyway.
    const email = plan.format === 'landing_page' ? null : fakeLib.renderEmail({} as ExpandedDraft, cat, envelope);
    out.push(...await itemSql(FX_RUN_ID, { plan, envelope, model_json: JSON.stringify(model), rendered: { email, landing_page, catalog: renderCatalog(plan, cat) },
      checks: checks ?? passing(plan.format), status }));
  }
  out.push(insert('units', { run_id: FX_RUN_ID, customer_id: 'c-nodraft', status: 'failed', code: 'COLD_START_NO_HISTORY', billed_attempts: 0 }));
  out.push(insert('units', { run_id: FX_RUN_ID, customer_id: 'c-over', status: 'skipped', code: 'OVER_CAP', billed_attempts: 0 }));
  return out;
}

function toCatalog(json: { snapshot_id: string; fetched_at: string; rows: Product[] }): Catalog {
  return { snapshot_id: json.snapshot_id, fetched_at: json.fetched_at, usable: json.rows, rows: new Map(json.rows.map((p) => [p.id, p])), by_sku: new Map(),
    rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: [] } };
}

async function main(argv: string[]): Promise<void> {
  const { execSync } = await import('node:child_process');
  const { mkdirSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { basename, join } = await import('node:path');
  const flag = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const wrangler = (args: string) => execSync(`npx wrangler ${args}`, { stdio: 'inherit' });

  let sql: string[];
  const dir = flag('--voice');
  if (argv.includes('--fixtures')) sql = await fixtureSql();
  else if (dir) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as VoiceFile);
    if (!files.length) throw new Error(`no voice files in ${dir}`);
    let path = flag('--catalog');
    if (!path) {
      path = 'out/seed/catalog.json';
      mkdirSync('out/seed', { recursive: true });
      wrangler(`r2 object get nicobar/snapshots/${files[0].envelope.snapshot_id}/catalog.json --local --file ${path}`);
    }
    sql = await voiceSql(files, toCatalog(JSON.parse(readFileSync(path, 'utf8'))), basename(dir.replace(/\/$/, '')));
  } else throw new Error('usage: node scripts/seed.ts --fixtures | --voice <dir> [--catalog <file>]');

  mkdirSync('out/seed', { recursive: true });
  writeFileSync('out/seed/seed.sql', `${sql.join(';\n')};\n`);
  wrangler('d1 migrations apply nicobar --local');
  wrangler('d1 execute nicobar --local --file out/seed/seed.sql');
  console.log(JSON.stringify({ step: 'seed', status: 'ok', statements: sql.length }));
}

if (globalThis.process?.argv?.[1]?.endsWith('seed.ts')) await main(process.argv.slice(2));
