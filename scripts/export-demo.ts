// Builds out/demo/seed.sql for the link. Local only: it works on a copy of the local D1 state and never reaches Cloudflare.
// `node scripts/export-demo.ts`. Applying the file is a separate step, on the owner's word.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DB = 'nicobar';
export const SEED_ACTOR = 'seed-demo@local';
export const O5 = { released: 2, approved: 1 };       // the rest stay in_review
export const SEED_TABLES = ['snapshots', 'runs', 'units', 'plans', 'drafts', 'draft_events', 'cost_events', 'jev_events', 'generations', 'config_versions'];
export const RESET_TABLES = [...SEED_TABLES, 'jev_dismissals'];      // starts empty on the link, live; the reset clears it
export const MAX_STATEMENT = 100_000;                 // D1 limits page [verified 2026-11-01]
const CHUNK_BYTES = 90_000;                           // literal bytes; leaves room for the UPDATE around it
const LARGE_VALUE = 10_000;
const KEYS: Record<string, string[]> = { drafts: ['id'], plans: ['run_id', 'customer_id'], config_versions: ['id'], generations: ['run_id', 'customer_id', 'attempt'] };   // the tables that hold long text

// Seen in the frozen site cache 2026-11-01. Alone these prove nothing; beside the first name they still fail.
const SITE_WORDS = new Set(['Das', 'Singh', 'lal', 'Palace', 'Patel']);

const bytes = (s: string) => Buffer.byteLength(s);
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function wrangler(cfg: string, ...args: string[]): string {
  return execFileSync(join(ROOT, 'node_modules/.bin/wrangler'), [...args, '-c', cfg],
    { encoding: 'utf8', stdio: 'pipe', maxBuffer: 1 << 29, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
}
export const query = <T = Record<string, unknown>>(cfg: string, sql: string): T[] =>
  (JSON.parse(wrangler(cfg, 'd1', 'execute', DB, '--local', '--json', '--command', sql)) as { results: T[] }[])[0].results;

export interface Selected { f: { id: string; prompt_version: string; jev_config_version: string }; isolation: { id: string } }

/** Latest finished run of each stage, on a real snapshot: fixture rows carry `snapshots.synthetic = 1`. */
export function selectRuns(cfg: string): Selected {
  const latest = (stage: string, extra = '') => query<Selected['f']>(cfg, `SELECT r.id, r.prompt_version, r.jev_config_version FROM runs r JOIN snapshots s ON s.id = r.snapshot_id
    WHERE r.stage = '${stage}' AND r.status = 'done' AND s.synthetic = 0 ${extra} ORDER BY r.created_at DESC LIMIT 1`)[0];
  const f = latest('F', "AND r.id NOT LIKE 'stub-%'"), isolation = latest('isolation');
  if (!f) throw new Error('refused: no done stage F run on a real snapshot');
  if (!isolation) throw new Error('refused: no done isolation run on a real snapshot');
  return { f, isolation };
}

export function pinsRefusal(f: Selected['f'], active: { id: string; kind: string }[]): string[] {
  const want = { prompt: f.prompt_version, jev: f.jev_config_version };
  return Object.entries(want).flatMap(([kind, id]) => {
    const now = active.find((a) => a.kind === kind)?.id;
    return now === id ? [] : [`refused: active ${kind} is ${now ?? 'absent'}, F pinned ${id}`];
  });
}

/** Sorted, so a reseed picks the same customers. Each step is a real POST; a refusal stops the export. */
export async function driveToO5(ids: string[], post: (id: string, action: 'approve' | 'release') => Promise<{ status: number; body: string }>): Promise<void> {
  const want = O5.released + O5.approved;
  if (ids.length < want) throw new Error(`refused: ${ids.length} drafts in review, O5 needs ${want}`);
  const sorted = [...ids].sort();
  const step = async (id: string, action: 'approve' | 'release') => {
    const r = await post(id, action);
    if (r.status !== 200) throw new Error(`${action} ${id}: ${r.status} ${r.body}`);
  };
  for (const id of sorted.slice(0, want)) await step(id, 'approve');
  for (const id of sorted.slice(0, O5.released)) await step(id, 'release');
}

/** What the read-only link reads. Customer and recs files stay home: only a run reads them, the link cannot run, and they hold last names. */
export const r2Keys = (snapshot: string | string[]) => {
  const ids = [snapshot].flat(), keys = (files: string[]) => ids.flatMap((id) => files.map((f) => `snapshots/${id}/${f}.json`));
  return { required: keys(['catalog', 'rules']), optional: keys(['report', 'detail', 'vocabulary']) };
};

/** Run on the copy, so `d1 export` holds nothing else. F keeps its rows; isolation keeps `runs`, `units`. */
export function pruneSql(fId: string, isolationId: string): string {
  const f = lit(fId), both = `${f}, ${lit(isolationId)}`;
  return [`DELETE FROM runs WHERE id NOT IN (${both});`, `DELETE FROM units WHERE run_id NOT IN (${both});`,
    `DELETE FROM draft_events WHERE draft_id NOT IN (SELECT id FROM drafts WHERE run_id = ${f});`,
    ...['plans', 'drafts', 'cost_events', 'jev_events', 'generations'].map((t) => `DELETE FROM ${t} WHERE run_id <> ${f};`),
    'DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM runs);',
    `DELETE FROM config_versions WHERE status <> 'active' AND id NOT IN (SELECT prompt_version FROM runs UNION SELECT voice_guide_version FROM runs UNION SELECT jev_config_version FROM runs UNION SELECT catalog_version FROM runs WHERE catalog_version IS NOT NULL UNION SELECT ranking_version FROM runs WHERE ranking_version IS NOT NULL);`,
  ].join('\n');
}

/** `exempt` is for the bundle's c8n.json spans; the seed passes none. */
export function leakErrors(text: string, customersTsv: string, exempt: string[] = []): string[] {
  let hay = text.replaceAll("''", "'").replaceAll('&#39;', "'").replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll("\\'", "'");
  for (const span of exempt) hay = hay.replaceAll(span, '');
  const errors: string[] = [];
  for (const row of customersTsv.trim().split('\n').slice(1)) {
    const [id, first, last, , note] = row.split('\t');
    if (last) {
      const name = last.length > 1 ? last[0].toUpperCase() + last.slice(1) : last.toUpperCase();
      const full = `${first[0].toUpperCase()}${first.slice(1)} ${name}`;
      if (new RegExp(`\\b${escapeRe(first)}\\s+${escapeRe(last)}\\b`, 'i').test(hay)) errors.push(`last name: ${full}`);
      else if (last.length >= 3 && last !== first && !SITE_WORDS.has(last) && new RegExp(`\\b${escapeRe(last)}\\b`).test(hay)) errors.push(`last name: ${last}`);
    }
    if (note?.trim() && hay.includes(note.trim())) errors.push(`whole note: ${id}`);
  }
  return errors;
}

interface Value { raw: string; text: string | null; end: number }

/** One SQL value from `d1 export`: NULL, a number, 'text', or replace(<value>,'<marker>',char(n)). */
function readValue(s: string, at: number): Value {
  if (s[at] === "'") {
    let i = at + 1, text = '';
    for (;;) {
      const q = s.indexOf("'", i);
      if (q < 0) throw new Error('unterminated literal in export');
      text += s.slice(i, q);
      if (s[q + 1] !== "'") return { raw: s.slice(at, q + 1), text, end: q + 1 };
      text += "'";
      i = q + 2;
    }
  }
  if (s.startsWith('replace(', at)) {
    const inner = readValue(s, at + 8);
    const marker = readValue(s, inner.end + 1);
    const m = /^,char\((\d+)\)\)/.exec(s.slice(marker.end, marker.end + 16));
    if (!m || inner.text === null || marker.text === null) throw new Error('unexpected replace() in export');
    const end = marker.end + m[0].length;
    return { raw: s.slice(at, end), text: inner.text.replaceAll(marker.text, String.fromCharCode(Number(m[1]))), end };
  }
  const end = at + /^[^,)]*/.exec(s.slice(at, at + 64))![0].length;
  return { raw: s.slice(at, end), text: null, end };
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = '', size = 0;
  for (const ch of text) {                            // by code point; a quote doubles when written
    const n = ch === "'" ? 2 : bytes(ch);
    if (size + n > CHUNK_BYTES) { out.push(cur); cur = ''; size = 0; }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

/** Over the cap: the INSERT carries empty text and UPDATEs append it, because `d1 execute --file` has no binds. */
function splitStatement(stmt: string, table: string): string[] {
  const keys = KEYS[table];
  if (!keys) throw new Error(`refused: statement over ${MAX_STATEMENT} bytes in ${table}, which has no key to chunk on`);
  const head = /^INSERT INTO "\w+" \(([^)]*)\) VALUES\(/.exec(stmt);
  if (!head) throw new Error(`unexpected statement: ${stmt.slice(0, 60)}`);
  const cols = head[1].split(',').map((c) => c.replaceAll('"', ''));
  const vals: Value[] = [];
  for (let at = head[0].length; vals.length < cols.length; at = vals.at(-1)!.end + 1) vals.push(readValue(stmt, at));
  const where = keys.map((k) => `"${k}" = ${vals[cols.indexOf(k)].raw}`).join(' AND ');
  const updates = vals.flatMap((v, i) => (v.text !== null && bytes(v.raw) > LARGE_VALUE
    ? chunks(v.text).map((c) => `UPDATE "${table}" SET "${cols[i]}" = "${cols[i]}" || ${lit(c)} WHERE ${where};`) : []));
  const insert = `${head[0]}${vals.map((v) => (v.text !== null && bytes(v.raw) > LARGE_VALUE ? "''" : v.raw)).join(',')});`;
  return [insert, ...updates];
}

export interface Seed { sql: string; statements: string[]; largest: number }

export function buildSeed(exportSql: string): Seed {
  const statements = exportSql.split('\n').filter((l) => l.trim() && !l.startsWith('PRAGMA ')).flatMap((stmt) => {
    const table = /^INSERT INTO "(\w+)" /.exec(stmt)?.[1];
    if (!table) throw new Error(`unexpected statement in export: ${stmt.slice(0, 60)}`);
    if (!SEED_TABLES.includes(table)) throw new Error(`refused: ${table} is not a seeded table`);
    return bytes(stmt) <= MAX_STATEMENT ? [stmt] : splitStatement(stmt, table);
  });
  const all = [...RESET_TABLES.map((t) => `DELETE FROM "${t}";`), ...statements];
  const largest = Math.max(...all.map(bytes));
  if (largest > MAX_STATEMENT) throw new Error(`refused: largest statement ${largest} bytes`);
  return { sql: `${all.join('\n')}\n`, statements: all, largest };
}

/** `d1 export` writes a newline as the two characters \\n and restores them with replace(), so a cell holding both a newline and a literal \\n comes back
 * changed, content_sha256 breaks, and E4 answers HASH_MISMATCH on the link. Same for \\r. wrangler 4.156.0 [verified 2026-11-01]. Refuse, never ship that seed. */
export function damagedCells(cfg: string): string[] {
  return SEED_TABLES.flatMap((t) => {
    const cols = query<{ name: string }>(cfg, `SELECT name FROM pragma_table_info('${t}') WHERE type = 'TEXT'`).map((c) => c.name);
    const sums = cols.map((c) => `COALESCE(SUM((instr(${c}, char(10)) > 0 AND instr(${c}, '\\n') > 0) OR (instr(${c}, char(13)) > 0 AND instr(${c}, '\\r') > 0)), 0) AS ${c}`);
    return Object.entries(query<Record<string, number>>(cfg, `SELECT ${sums.join(', ')} FROM ${t}`)[0]).filter(([, n]) => n).map(([c, n]) => `${t}.${c}: ${n}`);
  });
}

/** Destroys rows in `cfg`'s state, so `cfg` must be the copy. The leak scan runs before chunking, which could split a name. */
export function exportFromCopy(cfg: string, runs: Selected, customersTsv: string, exempt: string[]): Seed {
  const dir = resolve(cfg, '..');
  writeFileSync(join(dir, 'prune.sql'), pruneSql(runs.f.id, runs.isolation.id));
  wrangler(cfg, 'd1', 'execute', DB, '--local', '--file', join(dir, 'prune.sql'));
  const damaged = damagedCells(cfg);
  if (damaged.length) throw new Error(`refused: d1 export would change these cells: ${damaged.join('; ')}`);
  const output = join(dir, 'export.sql');
  wrangler(cfg, 'd1', 'export', DB, '--local', '--no-schema', ...SEED_TABLES.flatMap((t) => ['--table', t]), '--output', output);
  const exported = readFileSync(output, 'utf8');
  const leaks = leakErrors(exported, customersTsv, exempt);
  if (leaks.length) throw new Error(`refused: ${leaks.join('; ')}`);
  return buildSeed(exported);
}

/** Copies out of local R2 for the parent to upload. A required file missing refuses; a snapshot older than a side file just lacks it. */
export function exportR2(cfg: string, outDir: string): { key: string; bytes: number }[] {
  const { required, optional } = r2Keys(query<{ id: string }>(cfg, 'SELECT id FROM snapshots').map((s) => s.id));
  const get = (key: string) => {
    const file = join(outDir, key);
    mkdirSync(resolve(file, '..'), { recursive: true });
    wrangler(cfg, 'r2', 'object', 'get', `${DB}/${key}`, '--local', '--file', file);
    return { key, bytes: statSync(file).size };
  };
  const out = required.map(get);
  for (const key of optional) { try { out.push(get(key)); } catch { console.warn(`absent, not shipped: ${key}`); } }
  return out;
}

async function driveOnCopy(cfg: string, draftIds: string[]): Promise<void> {
  const port = 8798, base = `http://127.0.0.1:${port}`;
  const dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '-c', cfg, '--persist-to', join(resolve(cfg, '..'), '.wrangler/state'), '--port', String(port), '--var', 'DEV_MODE:1', '--var', `DEV_ACTOR:${SEED_ACTOR}`],
    { stdio: 'ignore', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = (await fetch(`${base}/review`).catch(() => null))?.status === 200;
      if (!up) await new Promise((ok) => setTimeout(ok, 500));
    }
    if (!up) throw new Error('local worker did not start');
    await driveToO5(draftIds, async (id, action) => {
      const res = await fetch(`${base}/api/drafts/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { Origin: base } });
      return { status: res.status, body: await res.text() };
    });
  } finally {
    process.kill(-dev.pid!);
  }
}

async function main(): Promise<void> {
  const state = join(ROOT, '.wrangler/state');
  if (!existsSync(state)) throw new Error('no local D1 state');
  mkdirSync(join(ROOT, 'out/demo'), { recursive: true });
  const work = mkdtempSync(join(ROOT, 'out/demo/copy-'));
  try {
    cpSync(state, join(work, '.wrangler/state'), { recursive: true });
    const config = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
    const cfg = join(work, 'wrangler.jsonc');
    // Sits beside the copy, so every wrangler call below reads the copy's state. No .dev.vars here, so no key reaches this server.
    writeFileSync(cfg, JSON.stringify({ ...config, build: undefined, main: join(ROOT, config.main), env: undefined,
      d1_databases: config.d1_databases.map((d: object) => ({ ...d, migrations_dir: join(ROOT, 'migrations') })) }));
    const runs = selectRuns(cfg);
    const refusals = pinsRefusal(runs.f, query<{ id: string; kind: string }>(cfg, `SELECT id, kind FROM config_versions WHERE status = 'active'`));
    if (refusals.length) throw new Error(refusals.join('; '));
    const ids = query<{ id: string }>(cfg, `SELECT id FROM drafts WHERE run_id = '${runs.f.id.replaceAll("'", "''")}' AND status = 'in_review'`).map((r) => r.id);
    await driveOnCopy(cfg, ids);
    const seed = exportFromCopy(cfg, runs, readFileSync(join(ROOT, 'data/customers.nicobar.tsv'), 'utf8'), []);
    writeFileSync(join(ROOT, 'out/demo/seed.sql'), seed.sql);
    console.log(`out/demo/seed.sql: ${seed.statements.length} statements, ${bytes(seed.sql)} bytes, largest ${seed.largest}, cap ${MAX_STATEMENT}`);
    const files = exportR2(cfg, join(ROOT, 'out/demo/r2'));
    writeFileSync(join(ROOT, 'out/demo/r2-keys.txt'), `${files.map((f) => f.key).join('\n')}\n`);
    console.log(`out/demo/r2: ${files.length} files, ${files.reduce((t, f) => t + f.bytes, 0)} bytes`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
