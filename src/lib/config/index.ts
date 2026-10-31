// Prompt and Jev versions. saveVersion inserts; activateVersion alone updates. Content never changes.
import type { ErrorCode } from '../../contracts/codes.ts';
import type { Actor, AppEnv, Catalog, ConfigFailure, ConfigKind, ConfigStatus, ConfigVersion, EvalValidity, FlagView, JevConfig, J3Input, JevQuestion, Plan, PromptFiles,
  Stage, ValidationResult } from '../../contracts/types.ts';
import { assemblePrefix, renderSuffix } from '../gen/index.ts';
import { canonicalContent } from '../gen/canonical.ts';
import { flaggedQuestions } from '../jev/index.ts';
import { BUNDLE, FX_CAT, FX_PLAN, PROMPT_MAX_BYTES, PROMPT_MIN_BYTES, sha256Hex } from './bundle.ts';

type Bundle = { schemas: object[]; jevBase: JevConfig };
export class ConfigErr extends Error {
  code: ErrorCode; detail?: unknown;
  constructor(code: ErrorCode, detail?: unknown) { super(code); this.code = code; this.detail = detail; }
}

const FILES: (keyof PromptFiles)[] = ['role', 'voice_card', 'email', 'landing', 'task', 'retry'];
const TASK = ['parts', 'n', 'occasion_key', 'shape', 'title_words', 'title_words_email', 'occasion', 'picks', 'quotes'];
const RETRY = ['parts', 'checks'];
const J3_KEYS: (keyof J3Input)[] = ['email', 'landing_page', 'quote', 'picks', 'occasion', 'occasion_key', 'new_user'];

// ---- hashing ----
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)])) : v;
/** Everything §13 locks: the config minus `version`, the gates and each question's wording. */
function locked(c: JevConfig): unknown {
  const { version: _v, flag_gate: _g, score_flag_confidence: _s, j3, ...rest } = c;
  return stable({ ...rest, j3: Object.fromEntries(Object.entries(j3 ?? {}).map(([k, q]) => {
    const { instructions: _i, criteria: _c, ...kept } = (q ?? {}) as JevQuestion;
    return [k, kept];
  })) });
}
const baseHash = (kind: ConfigKind, b: Bundle) => sha256Hex(JSON.stringify(kind === 'prompt' ? b.schemas : locked(b.jevBase)));

// ---- reading ----
interface Row { id: string; kind: ConfigKind; parent_id: string | null; content_json: string; sha256: string; base_sha256: string; voice_guide_version: string | null;
  status: ConfigStatus; note: string; created_by: string; created_at: string; activated_by: string | null; activated_at: string | null }
const version = ({ content_json, ...r }: Row): ConfigVersion => ({ ...r, content: JSON.parse(content_json) });

/** No hash check: for screens, which must still open on a tampered or old-base row. Runs use loadVersion. */
export async function readVersion(db: D1Database, id: string): Promise<ConfigVersion | null> {
  const r = await db.prepare('SELECT * FROM config_versions WHERE id = ?').bind(id).first<Row>();
  return r && version(r);
}
export async function listVersions(db: D1Database): Promise<ConfigVersion[]> {
  return (await db.prepare('SELECT * FROM config_versions ORDER BY kind, created_at DESC, id DESC').all<Row>()).results.map(version);
}
export async function activeVersions(db: D1Database): Promise<{ prompt: ConfigVersion; jev: ConfigVersion }> {
  const rows = (await db.prepare(`SELECT * FROM config_versions WHERE status = 'active'`).all<Row>()).results.map(version);
  const prompt = rows.find((r) => r.kind === 'prompt');
  const jev = rows.find((r) => r.kind === 'jev');
  if (!prompt || !jev) throw new ConfigErr('CONFIG_MISSING');
  return { prompt, jev };
}
export async function loadVersion(db: D1Database, id: string, bundle: Bundle): Promise<ConfigVersion> {
  const r = await db.prepare('SELECT * FROM config_versions WHERE id = ?').bind(id).first<Row>();
  if (!r) throw new ConfigErr('CONFIG_MISSING');
  if (await sha256Hex(r.content_json) !== r.sha256) throw new ConfigErr('TAMPERED');
  if (await baseHash(r.kind, bundle) !== r.base_sha256) throw new ConfigErr('BASE_CHANGED');
  return version(r);
}
const activeId = async (db: D1Database, kind: ConfigKind) =>
  (await db.prepare(`SELECT id FROM config_versions WHERE kind = ? AND status = 'active'`).bind(kind).first<{ id: string }>())?.id ?? null;

// ---- validation ----
const placeholders = (t: string) => [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
const sameSet = (a: string[], b: string[]) => new Set(a).size === b.length && b.every((x) => a.includes(x));

export function validatePrompt(files: PromptFiles, schemas: object[], fixture: Plan, cat: Catalog): ValidationResult {
  const failures: ConfigFailure[] = [];
  const fail = (rule: string, detail: string, file?: string) => failures.push({ rule, file, detail });
  for (const f of ['role', 'voice_card', 'email', 'landing'] as const)
    if (files[f].includes('{{')) fail('prefix_placeholder', 'nothing per-customer may enter the prefix', f);
  if (!sameSet(placeholders(files.task), TASK)) fail('task_placeholders', `exactly: ${TASK.join(' ')}`, 'task');
  if (!sameSet(placeholders(files.retry), RETRY)) fail('retry_placeholders', `exactly: ${RETRY.join(' ')}`, 'retry');
  for (const f of FILES) {
    if (files[f].includes('# Output schemas')) fail('schema_heading', 'schemas are bundled, not edited', f);
    if (/sk-ant-|\.dev\.vars/.test(files[f])) fail('secret', 'no key or secrets-file text', f);
  }
  const prefix = assemblePrefix(files, schemas);
  const retry = { failed: ['email' as const], checks: [] };
  if ([prefix, renderSuffix(fixture, cat, files), renderSuffix(fixture, cat, files, retry)].some((t) => t.includes('{{'))) fail('unrendered', '{{ left after rendering');
  const prefix_bytes = new TextEncoder().encode(prefix).length;
  if (prefix_bytes > PROMPT_MAX_BYTES || prefix_bytes < PROMPT_MIN_BYTES) fail('prefix_size', `${prefix_bytes} bytes, want ${PROMPT_MIN_BYTES} to ${PROMPT_MAX_BYTES}`);
  return failures.length ? { ok: false, failures } : { ok: true, prefix_bytes };
}

const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const side = (s: { what?: unknown; examples?: unknown } | undefined) => !!s && text(s.what) && Array.isArray(s.examples) && s.examples.length >= 1 && s.examples.every(text);

export function validateJev(next: JevConfig, base: JevConfig): ValidationResult {
  const failures: ConfigFailure[] = [];
  const fail = (rule: string, detail: string) => failures.push({ rule, detail });
  const j3 = next.j3 ?? {};
  if (!sameSet(Object.keys(j3), Object.keys(base.j3))) fail('question_keys', 'questions are the base set');
  const keys = Object.keys(base.j3).filter((k) => j3[k]);
  if (JSON.stringify(locked({ ...next, j3: Object.fromEntries(keys.map((k) => [k, j3[k]])) })) !== JSON.stringify(locked({ ...base, j3: Object.fromEntries(keys.map((k) => [k, base.j3[k]])) })))
    fail('locked', 'model, deadline_ms, basis_usd, act_gate, act, type and bad stay as config/jev.json');
  for (const k of keys) {
    const q = j3[k], b = base.j3[k];
    if (b.type === 'noul' && (!side((q.criteria as { true?: object })?.true) || !side((q.criteria as { false?: object })?.false))) fail('noul_sides', `${k}: both sides, each with an example`);
    if (b.type === 'score' && !(Array.isArray(q.criteria) && q.criteria.length === 4 && q.criteria.every(text))) fail('score_anchors', `${k}: 4 anchors`);
    if (!text(q.instructions)) fail('instructions', `${k}: empty`);
    for (const [, path] of JSON.stringify([q.instructions, q.criteria]).matchAll(/`([^`]*)`/g))
      if (!(J3_KEYS as string[]).includes(path)) fail('state_paths', `${k}: \`${path}\` is not a J3Input key`);
  }
  const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
  if (!inRange(next.flag_gate, 0.3, 0.7)) fail('gate_range', 'flag_gate 0.3 to 0.7');
  if (!inRange(next.score_flag_confidence, 0.4, 0.8)) fail('gate_range', 'score_flag_confidence 0.4 to 0.8');
  return failures.length ? { ok: false, failures } : { ok: true };
}
export const validateVersion = (v: ConfigVersion): ValidationResult => v.kind === 'prompt'
  ? validatePrompt(v.content as PromptFiles, BUNDLE.schemas, FX_PLAN, FX_CAT) : validateJev(v.content as JevConfig, BUNDLE.jevBase);

// ---- writing ----
const lf = <T>(v: T): T => (typeof v === 'string' ? v.replaceAll('\r\n', '\n') as T
  : Array.isArray(v) ? v.map(lf) as T
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lf(x)])) as T : v);
function human(actor: Actor): Exclude<Actor, { kind: 'system' }> {
  if (actor.kind === 'system') throw new ConfigErr('FORBIDDEN', 'a system actor cannot change config');
  return actor;
}
const hasFiles = (c: object) => sameSet(Object.keys(c), FILES) && FILES.every((f) => typeof (c as PromptFiles)[f] === 'string');

export async function saveVersion(db: D1Database, kind: ConfigKind, parent_id: string | null, content: PromptFiles | JevConfig, note: string, actor: Actor): Promise<ConfigVersion> {
  const who = human(actor);
  if (!text(note)) throw new ConfigErr('BAD_INPUT', 'note');
  if (!content || typeof content !== 'object' || (kind === 'prompt' ? !hasFiles(content) : !(content as JevConfig).j3)) throw new ConfigErr('BAD_INPUT', 'content');
  if (await activeId(db, kind) !== parent_id) throw new ConfigErr('STALE_PARENT');
  const parent = parent_id ? await readVersion(db, parent_id) : null;
  const ids = (await db.prepare('SELECT id FROM config_versions WHERE kind = ?').bind(kind).all<{ id: string }>()).results;
  const n = Math.max(0, ...ids.map((r) => Number(r.id.match(/\d+$/)?.[0] ?? 0))) + 1;
  const id = kind === 'prompt' ? `v${n}` : `jev-v${n}`;
  const next = lf(kind === 'jev' ? { ...content, version: id } as JevConfig : content);
  const content_json = canonicalContent(next);
  if (parent) {
    const compare = kind === 'jev' ? canonicalContent({ ...next, version: (parent.content as JevConfig).version } as JevConfig) : content_json;
    if (await sha256Hex(compare) === parent.sha256) throw new ConfigErr('UNCHANGED');
  }
  const vgv = kind === 'jev' ? null
    : parent && (parent.content as PromptFiles).voice_card === (next as PromptFiles).voice_card ? parent.voice_guide_version : id;
  await db.prepare(`INSERT INTO config_versions (id, kind, parent_id, content_json, sha256, base_sha256, voice_guide_version, status, note, created_kind, created_by, created_sub, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`).bind(id, kind, parent_id, content_json, await sha256Hex(content_json), await baseHash(kind, BUNDLE), vgv, note, who.kind,
    who.email, who.sub, new Date().toISOString()).run();
  return (await readVersion(db, id))!;
}

export async function activateVersion(db: D1Database, id: string, actor: Actor): Promise<ConfigVersion> {
  const who = human(actor);
  const v = await loadVersion(db, id, BUNDLE);
  if (v.status !== 'draft') throw new ConfigErr('WRONG_STATE');
  const result = validateVersion(v);
  if (!result.ok) throw new ConfigErr('VALIDATION_FAILED', result.failures);
  try {
    await db.batch([
      db.prepare(`UPDATE config_versions SET status = 'retired' WHERE id = ? AND status = 'active'`).bind(v.parent_id),
      db.prepare(`UPDATE config_versions SET status = 'active', activated_by = ?, activated_sub = ?, activated_at = ?, validation_json = ? WHERE id = ? AND status = 'draft'`)
        .bind(who.email, who.sub, new Date().toISOString(), JSON.stringify(result), id)]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new ConfigErr('STALE_PARENT');   // the parent is not the active row, so one_active refused the swap
    throw e;
  }
  return (await readVersion(db, id))!;
}

export function lineDiff(a: string, b: string): { op: '=' | '+' | '-'; text: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  // ponytail: full LCS table, O(n·m); a prompt file is a few hundred lines.
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: '=' | '+' | '-'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push({ op: '=', text: x[i] }); i++; j++; }
    else if (j >= y.length || (i < x.length && t[i + 1][j] >= t[i][j + 1])) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  return out;
}

// ---- flags ----
interface DraftRef { run_id: string; customer_id: string; version: number; status: string; jev_config_version: string }
async function draftRef(db: D1Database, draft_id: string): Promise<DraftRef> {
  const d = await db.prepare(`SELECT d.run_id, d.customer_id, d.version, d.status, r.jev_config_version FROM drafts d JOIN runs r ON r.id = d.run_id WHERE d.id = ?`).bind(draft_id).first<DraftRef>();
  if (!d) throw new ConfigErr('NOT_FOUND');
  return d;
}
export async function reviewFlags(env: AppEnv, draft_id: string): Promise<FlagView[]> {
  const d = await draftRef(env.DB, draft_id);
  const key = [d.run_id, d.customer_id, d.version];
  const event = await env.DB.prepare('SELECT answers_json FROM jev_events WHERE run_id = ? AND customer_id = ? AND attempt = ?').bind(...key).first<{ answers_json: string | null }>();
  if (!event?.answers_json) return [];
  const cfg = (await loadVersion(env.DB, d.jev_config_version, BUNDLE)).content as JevConfig;   // the pinned config, never the active one
  const flagged = flaggedQuestions(JSON.parse(event.answers_json), cfg);
  const rows = (await env.DB.prepare('SELECT question, actor_email, at, note FROM jev_dismissals WHERE run_id = ? AND customer_id = ? AND attempt = ?').bind(...key)
    .all<{ question: string; actor_email: string; at: string; note: string }>()).results;
  return Object.keys(cfg.j3).map((question) => {
    const r = rows.find((x) => x.question === question);
    return { question, flagged: flagged.includes(question), dismissal: r ? { actor_email: r.actor_email, at: r.at, note: r.note } : null };
  });
}
export async function dismissFlag(env: AppEnv, draft_id: string, question: string, note: string, actor: Actor): Promise<void> {
  const who = human(actor);
  if (!text(note)) throw new ConfigErr('BAD_INPUT', 'note');
  const d = await draftRef(env.DB, draft_id);
  if (d.status !== 'in_review') throw new ConfigErr('WRONG_STATE');
  const flag = (await reviewFlags(env, draft_id)).find((f) => f.question === question);
  if (!flag?.flagged) throw new ConfigErr('NOT_FLAGGED');
  if (flag.dismissal) throw new ConfigErr('WRONG_STATE', 'already dismissed');
  await env.DB.prepare(`INSERT INTO jev_dismissals (run_id, customer_id, attempt, question, actor_kind, actor_email, actor_sub, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(d.run_id, d.customer_id, d.version, question, who.kind, who.email, who.sub, new Date().toISOString(), note).run();
}

// ---- eval validity ----
const PIN = { prompt: 'prompt_version', jev: 'jev_config_version' } as const;
const NEEDS: { goal: number; kinds: ConfigKind[]; stages: Stage[] }[] = [
  ...[10, 11, 12, 13].map((goal) => ({ goal, kinds: ['prompt'] as ConfigKind[], stages: ['F'] as Stage[] })),
  { goal: 14, kinds: ['prompt', 'jev'], stages: ['F'] },
  { goal: 15, kinds: ['jev'], stages: ['F'] },   // no run row of its own: current only while active Jev = F's
  ...[16, 17, 18].map((goal) => ({ goal, kinds: ['prompt'] as ConfigKind[], stages: ['F'] as Stage[] })),
  { goal: 19, kinds: ['prompt'], stages: ['F', 'Haiku'] },
  { goal: 20, kinds: ['prompt'], stages: ['F'] }];

export async function evalValidity(db: D1Database): Promise<EvalValidity[]> {
  const active = await activeVersions(db);
  type Pinned = { id: string; prompt_version: string; jev_config_version: string };
  const latest = async (stage: Stage) => db.prepare(`SELECT id, prompt_version, jev_config_version FROM runs WHERE stage = ? AND status = 'done' ORDER BY created_at DESC, id DESC LIMIT 1`).bind(stage).first<Pinned>();
  const runs = { F: await latest('F'), Haiku: await latest('Haiku') } as Record<Stage, Pinned | null>;
  return NEEDS.map(({ goal, kinds, stages }) => {
    const stale = kinds.filter((k) => stages.some((s) => runs[s]?.[PIN[k]] !== active[k].id));
    const kind = stale[0] ?? kinds[kinds.length - 1];   // row 14 hangs on both: name the one that voids it
    return { goal, kind, active_id: active[kind].id, stages, run_ids: stages.flatMap((s) => runs[s]?.id ?? []), state: stale.length ? 'no_run_yet' : 'current' };
  });
}
