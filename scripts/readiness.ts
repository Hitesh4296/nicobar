// `npm run readiness`: R1–R7 and line 4 on a real local `wrangler dev` against a scripted Messages stub. $0, no key, no remote.
// `--selftest` runs only the planted evidence. A line is PASS only if its assertion failed on planted bad evidence in this same process, failed again on a
// real run driven red through DEV_FAULT or the stub, and held on the real run. No seam red, or a prerequisite not built, is VOID, never PASS. reports/readiness.json is rewritten each time.
// S: the stub counts chars ÷ 4, so config/cap.json's S (a placeholder for real count_tokens) skips everyone. The Worker imports cap.json at bundle time, so the drive runs from a
// byte copy of the source under out/readiness/tree whose only difference is S, measured here on the stub's own count. cap.json in the repo is not touched.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-llm.ts';
import type { Call, StubOptions } from './stub-llm.ts';
const READINESS_KEY = 'readiness-only';   // a throwaway server's key, never a real one

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'out/readiness');
const TREE = join(OUT, 'tree');
const ISO = join(ROOT, 'test/fixtures/isolation');
const PORT = 8797, STUB_PORT = 8798, GEN_CONCURRENCY = 4, POLL_S = 180;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ---- verdicts, pure over evidence ----
export type Verdict = 'PASS' | 'FAIL' | 'VOID';
export interface Line { id: string; verdict: Verdict; why: string; red: string; seam_red: string[]; output: unknown; seam_output: unknown; clause_reds?: ClauseRed[] }
/** One clause driven red on its own run. `must`: this run has to open the clause, or the line is VOID. A rung without it records which layer still held. */
export interface ClauseRed { line: string; clause: string; via: string; must: boolean; opened: boolean; failures: string[]; evidence: unknown }
type Check = (e: any) => string[];   // returns the broken facts; [] holds
const eq = (name: string, got: unknown, want: unknown) => (got === want ? [] : [`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`]);

/** R1. finished: drafted before the kill. calls_after: stub calls per key after the kill. A repeat is a key also called before it: first calls for untouched customers are the resume doing its job.
 * In flight: called before the kill and not finished. Each gets exactly one call after it, and only those may be billed twice. */
const R1: Check = (e) => [
  ...Object.keys(e.calls_after).filter((k) => e.finished.includes(k)).map((k) => `finished ${k} called again`),
  ...eq('every unit terminal', e.open, 0),
  ...(e.called_before.filter((k: string) => k in e.calls_after).length > GEN_CONCURRENCY ? [`${e.called_before.filter((k: string) => k in e.calls_after).length} in-flight repeats > ${GEN_CONCURRENCY}`] : []),
  ...e.called_before.filter((k: string) => !e.finished.includes(k) && e.calls_after[k] !== 1).map((k: string) => `in-flight ${k} called ${e.calls_after[k] ?? 0} times after the kill, want 1`),
  ...e.billed_twice.filter((b: any) => !e.called_before.includes(b.key) || e.finished.includes(b.key)).map((b: any) => `billed twice outside in-flight: ${b.key}`),
];
/** R2. A pause, a kill, a restart: attempt 1 is possibly_billed, and each stub call has its own attempt row. */
const R2: Check = (e) => [...eq('attempt 1 call_state', e.attempt1, 'possibly_billed'), ...eq('stub calls = attempt rows', e.calls, e.attempts)];
const R3: Check = (e) => [...eq('second POST', e.second_post, 409), ...eq('approve events', e.approve_events, 1), ...eq('release events', e.release_events, 1),
  ...eq('draft id', e.draft_id, e.want_draft_id)];
/** R4. units: key → 'status[:code]'. Each failure sits alone; `row:*` matches by prefix. */
const R4: Check = (e) => {
  const got = Object.entries<string>(e.units).map(([k, v]) => [k.startsWith('row:') ? 'row:*' : k, v]);
  return [...Object.entries(e.expected).filter(([k, v]) => !got.some(([g, s]) => g === k && s === v)).map(([k, v]) => `${k} wanted ${v}`),
    ...got.filter(([k]) => !(k! in e.expected)).map(([k]) => `unexpected unit ${k}`)];
};
const R5: Check = (e) => [...eq('429 then 200 billed', e.b429, 1), ...eq('refusal stub calls', e.refusal_calls, 1), ...eq('retry schema', e.retry_parts, 'landing_page'),
  ...eq('passing part byte-identical', e.carried_same, true), ...(e.max_billed > 2 ? [`billed ${e.max_billed}`] : [])];
const R6: Check = (e) => [...eq('oversized unit', e.big, 'skipped:OVER_CAP'), ...eq('oversized stub calls', e.big_calls, 0), ...eq('oversized charged', e.big_charged, 0),
  ...eq('oversized cost_events action', e.big_action, 'skip'), ...eq('cap_run_usd in body', e.cap_in_body, 400)];
/** R7. Every unit of a `done` run has a code or a draft. */
const R7: Check = (e) => [...eq('run status', e.status, 'done'), ...e.units.filter((u: any) => !u.code && !u.draft).map((u: any) => `${u.key} has neither`)];
const L4: Check = (e) => [...eq('release on in_review', e.release_in_review, 409), ...eq('status-only UPDATE', e.status_update, 'refused'),
  ...eq('/released before tamper', e.released_before, 200), ...(e.released_after === 200 ? ['/released still 200 after hash change'] : [])];

/** A check never seen failing is VOID. Each row: evidence that must hold, then a planted break that must fail. */
const iso = { 'c-ok-1': 'drafted', 'c-throw': 'failed:INTERNAL_ERROR', 'row:*': 'failed:INVALID_CUSTOMER' };
export const PLANTED: Record<string, { check: Check; good: unknown; bad: unknown[] }> = {
  R1: { check: R1, good: { finished: ['d01'], called_before: ['d01', 'd02'], calls_after: { d02: 1, d03: 1, d04: 1, d05: 1, d06: 1 }, open: 0, billed_twice: [{ key: 'd02', b: 2 }] }, bad: [{ finished: ['d01'], called_before: ['d01'], calls_after: { d01: 1 }, open: 0, billed_twice: [] },
    { finished: [], called_before: ['a', 'b', 'c', 'd', 'e'], calls_after: { a: 1, b: 1, c: 1, d: 1, e: 1 }, open: 0, billed_twice: [] }, { finished: [], called_before: [], calls_after: {}, open: 1, billed_twice: [] },
    { finished: ['d01'], called_before: ['d01', 'd02'], calls_after: { d02: 2 }, open: 0, billed_twice: [] }, { finished: ['d01'], called_before: ['d01', 'd02'], calls_after: {}, open: 0, billed_twice: [] },
    { finished: ['d01'], called_before: ['d01', 'd02'], calls_after: { d02: 1 }, open: 0, billed_twice: [{ key: 'd01', b: 2 }] }, { finished: ['d01'], called_before: ['d01', 'd02'], calls_after: { d02: 1, d09: 1 }, open: 0, billed_twice: [{ key: 'd09', b: 2 }] }] },
  R2: { check: R2, good: { attempt1: 'possibly_billed', calls: 2, attempts: 2 }, bad: [{ attempt1: 'answered', calls: 2, attempts: 2 }, { attempt1: 'possibly_billed', calls: 2, attempts: 1 }] },
  R3: { check: R3, good: { second_post: 409, approve_events: 1, release_events: 1, draft_id: 'r:c:v1', want_draft_id: 'r:c:v1' },
    bad: [{ second_post: 200, approve_events: 1, release_events: 1, draft_id: 'a', want_draft_id: 'a' }, { second_post: 409, approve_events: 2, release_events: 1, draft_id: 'a', want_draft_id: 'a' }] },
  R4: { check: R4, good: { expected: iso, units: { 'c-ok-1': 'drafted', 'c-throw': 'failed:INTERNAL_ERROR', 'row:6': 'failed:INVALID_CUSTOMER' } },
    bad: [{ expected: iso, units: { 'c-ok-1': 'drafted', 'c-throw': 'drafted', 'row:6': 'failed:INVALID_CUSTOMER' } },
      { expected: iso, units: { 'c-ok-1': 'failed:INTERNAL_ERROR', 'c-throw': 'failed:INTERNAL_ERROR', 'row:6': 'failed:INVALID_CUSTOMER' } }] },
  R5: { check: R5, good: { b429: 1, refusal_calls: 1, retry_parts: 'landing_page', carried_same: true, max_billed: 2 },
    bad: [{ b429: 2, refusal_calls: 1, retry_parts: 'landing_page', carried_same: true, max_billed: 2 }, { b429: 1, refusal_calls: 1, retry_parts: 'landing_page', carried_same: false, max_billed: 2 },
      { b429: 1, refusal_calls: 2, retry_parts: 'landing_page', carried_same: true, max_billed: 2 }] },
  R6: { check: R6, good: { big: 'skipped:OVER_CAP', big_calls: 0, big_charged: 0, big_action: 'skip', cap_in_body: 400 },
    bad: [{ big: 'skipped:OVER_CAP', big_calls: 1, big_charged: 0, big_action: 'skip', cap_in_body: 400 }, { big: 'skipped:OVER_CAP', big_calls: 0, big_charged: 0, big_action: null, cap_in_body: 400 },
      { big: 'skipped:OVER_CAP', big_calls: 0, big_charged: 0, big_action: 'skip', cap_in_body: 200 }] },
  R7: { check: R7, good: { status: 'done', units: [{ key: 'a', code: 'X', draft: null }, { key: 'b', code: null, draft: 'r:b:v1' }] },
    bad: [{ status: 'done', units: [{ key: 'a', code: null, draft: null }] }, { status: 'stopped', units: [] }] },
  L4: { check: L4, good: { release_in_review: 409, status_update: 'refused', released_before: 200, released_after: 409 },
    bad: [{ release_in_review: 200, status_update: 'refused', released_before: 200, released_after: 409 }, { release_in_review: 409, status_update: 'applied', released_before: 200, released_after: 409 },
      { release_in_review: 409, status_update: 'refused', released_before: 200, released_after: 200 }] },
};
/** Green on good, red on every planted bad. Returns one line per id, with the actual failures it printed. */
export function plantedProof(): Record<string, { ok: boolean; reds: string[][]; good: string[] }> {
  return Object.fromEntries(Object.entries(PLANTED).map(([id, p]) => {
    const good = p.check(p.good), reds = p.bad.map((b) => p.check(b));
    return [id, { ok: good.length === 0 && reds.every((r) => r.length > 0), reds, good }];
  }));
}

// ---- wrangler ----
/** detached makes wrangler a group leader; the group held all 6 processes including both workerd [verified 2026-11-01]. Killing less leaves an orphan that fakes a resume. */
const live = new Set<ChildProcess>();
let logs = 0;
function killTree(p: ChildProcess) { live.delete(p); try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } }
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
async function up(state: string, fault?: string): Promise<ChildProcess> {
  // --env-file: an empty file stops wrangler loading .dev.vars, so no real key can reach this run [verified 2026-11-01]
  const vars = { DEV_MODE: '1', DEV_ACTOR: 'readiness@local', RUN_KEY: READINESS_KEY, ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, ...(fault ? { DEV_FAULT: fault } : {}) };
  const log = openSync(join(OUT, `wrangler-${++logs}-${fault ?? 'plain'}.log`.replace(':', '-')), 'w');
  const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', state, '--env-file', join(OUT, 'empty.env'),
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: TREE, stdio: ['ignore', log, log], detached: true });
  closeSync(log);
  live.add(dev);
  for (let i = 0; i < 120; i++) { if (await fetch(url('/review')).catch(() => null)) return dev; await sleep(500); }
  killTree(dev); throw new Error('wrangler did not come up');
}
const sql = (state: string, command: string): any[] => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'nicobar', '--local', '--persist-to', state, '--json', '--command', command],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0].results;
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const post = (path: string, body: unknown) => fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', 'x-run-key': READINESS_KEY, origin: url('').replace(/\/$/, '') }, body: JSON.stringify(body) });
async function done(state: string, id: string, want = ['done', 'stopped']) {
  for (let i = 0; i < POLL_S / 2; i++) { const s = sql(state, `SELECT status FROM runs WHERE id=${q(id)}`)[0]?.status; if (want.includes(s)) return s; await sleep(2000); }
  throw new Error(`run ${id} not finished in ${POLL_S}s`);
}
const unitsOf = (state: string, id: string) => sql(state, `SELECT customer_id key, status, code FROM units WHERE run_id=${q(id)}`);

// ---- inputs, generated under out/ from the isolation rows, so every pick stays a real one ----
const OCC = ["Mother's birthday", 'Work trip to Singapore', 'Diwali at home', "Sister's wedding"];
const HEAD = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\n';
type Input = { tsv: string; recs: string; format: string };
/** What POST /api/runs checks a file against, read from the state this drive runs on. `soldOut` is what c-badpick's p4 needs to be. */
export interface Live { snapshot_id: string; generated_by: unknown; soldOut: string }
/** The fixture on today's snapshot, at today's versions. The fixture's p4 came back in stock, so it is picked from the snapshot, not pinned. */
export const liveRecs = (file: any, l: Live) => ({ ...file, snapshot_id: l.snapshot_id, generated_by: l.generated_by,
  rows: file.rows.map((r: any) => (r.customer_id === 'c-badpick' ? { ...r, picks: r.picks.map((p: any, i: number) => (i === 3 ? { ...p, product_id: l.soldOut } : p)) } : r)) });
function liveOf(state: string): Live {
  const data = json(join(ROOT, 'data/recommendations.synthetic.json')), id = data.snapshot_id;
  const active = (kind: string): string | undefined => sql(state, `SELECT id FROM config_versions WHERE kind = '${kind}' AND status = 'active'`)[0]?.id;
  const catalog = active('catalog');
  return { snapshot_id: id, generated_by: { ...data.generated_by, version: active('rank') ?? data.generated_by.version, ...(catalog ? { catalog_version: catalog } : {}) },
    soldOut: json(join(ROOT, 'out/snapshot', id, 'catalog.json')).rows.find((p: any) => p.excluded_reason === 'NOT_AVAILABLE').id };
}
function writeInput(live: Live, name: string, format: string, rows: { id: string; occ: string; picks: unknown[] }[]): Input {
  const tsv = join(OUT, `${name}.synthetic.tsv`), recs = join(OUT, `${name}.recs.synthetic.json`), base = json(join(ISO, 'recommendations.synthetic.json'));
  writeFileSync(tsv, HEAD + rows.map((r) => `${r.id}\tTest\tSynthetic\t${r.occ}\tBought a test item.\n`).join(''));
  writeFileSync(recs, JSON.stringify({ ...liveRecs(base, live), rule: `readiness ${name}`, rows: rows.map((r) => ({ customer_id: r.id, picks: r.picks })) }));
  return { tsv, recs, format };
}
export function inputs(live: Live) {
  const base = json(join(ISO, 'recommendations.synthetic.json')), iso = base.rows, isoRecs = join(OUT, 'isolation.recs.synthetic.json');
  writeFileSync(isoRecs, JSON.stringify({ ...liveRecs(base, live), rule: 'readiness isolation: picks copied from real rows; c-badpick p4 is sold out on this snapshot' }));
  const c02 = json(join(ROOT, 'data/recommendations.synthetic.json')).rows.find((r: any) => r.customer_id === 'c02').picks;
  const picks = (n: number) => iso.find((r: any) => r.customer_id === `c-ok-${n % 4 + 1}`).picks;
  const d = (i: number) => `d${String(i + 1).padStart(2, '0')}`;
  return {
    dur: writeInput(live, 'durability', 'landing_page', Array.from({ length: 12 }, (_, i) => ({ id: d(i), occ: `${OCC[i % 4]} ${d(i)}`, picks: picks(i) }))),
    retry: writeInput(live, 'retry', 'both', ['x429', 'xbad', 'xrefuse', 'xfail'].map((k) => ({ id: k, occ: `Monsoon in Kochi ${k}`, picks: c02 }))),
    // the same customers, with the stub answering worse: x429's first answer fails checks, so it bills twice; xbad fails both parts, so nothing carries
    retryRed: writeInput(live, 'retry-red', 'both', [['x429', 'xbad'], ['xbad', 'xbadboth'], ['xrefuse', 'xrefuse']].map(([k, m]) => ({ id: k!, occ: `Monsoon in Kochi ${m}`, picks: c02 }))),
    // U_hard is 26,760 tokens; about 4 characters a token, so 160 KB of occasion is over it on any tokenizer
    cap: writeInput(live, 'cap', 'landing_page', [{ id: 'big', occ: `${'Diwali at home '.repeat(11_000)}big`, picks: picks(2) }, { id: 'ok1', occ: 'Diwali at home ok1', picks: picks(2) }]),
    isolation: { tsv: join(ISO, 'customers.synthetic.tsv'), recs: isoRecs, format: 'landing_page' },
  };
}
/** The body of POST /api/runs. Both files travel as bytes, because the preview hashes bytes. Format and rung come from the preview. */
const runBody = (id: string, stage: string, f: Input, preview_sha256: string) => ({ run_id: id, stage, snapshot_id: json(f.recs).snapshot_id, customers_name: basename(f.tsv),
  customers_tsv: readFileSync(f.tsv, 'utf8'), customers_synthetic: true, recs_json: readFileSync(f.recs, 'utf8'), preview_sha256 });

/** scripts/preview.ts's CLI reads data/ only, so its `preview()` runs here on these inputs. Writes each preview to `state`'s R2 with no server up. Also measures S. */
async function previewAll(f: Record<string, Input>, state: string) {
  const [{ getPlatformProxy }, ingest, recs, plan, check, cost, catalog, gen, { preview }, { makeClient, planAll }, { PROMPT_DIR, PROMPT_ID, readPromptDir }] = await Promise.all([import('wrangler'), import('../src/lib/ingest.ts'),
    import('../src/lib/recs.ts'), import('../src/lib/plan.ts'), import('../src/lib/check/index.ts'), import('../src/lib/cost/index.ts'), import('../src/lib/catalog/index.ts'), import('../src/lib/gen/index.ts'),
    import('./preview.ts'), import('./draft-one.ts'), import('./prompt-dir.ts')]);
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const proxy = await getPlatformProxy<any>({ configPath: join(ROOT, 'wrangler.jsonc'), persist: { path: join(state, 'v3') } });
  try {
    const prompt = readPromptDir(join(ROOT, PROMPT_DIR));
    const base = { lib: { ...ingest, ...recs, ...plan, ...check, ...cost }, client: makeClient({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}` }), log: () => {}, prices: json(join(ROOT, 'config/prices.json')),
      rungs: json(join(ROOT, 'config/rungs.json')), cap: json(join(TREE, 'config/cap.json')), put: (k: string, t: string) => proxy.env.BUCKET.put(k, t) };
    const inputsOf = (i: Input) => ({ customers: readFileSync(i.tsv, 'utf8'), recs: readFileSync(i.recs, 'utf8'), keys: read('data/row_keys.synthetic.json'), shapes: read('config/shapes.json') });
    const cat = await catalog.loadCatalog(proxy.env, json(f.isolation!.recs).snapshot_id);
    // measured: what the stub counts for everything but the user message, per format
    const S: Record<string, number> = {};
    for (const format of ['both', 'email', 'landing_page'] as const) {
      const d = { ...base, inputs: { ...inputsOf(f.isolation!), cat } } as any;
      const { pinned, plans } = planAll({ prompt, promptId: PROMPT_ID, format }, 'measure', d);
      const { max_tokens: _omit, ...body } = gen.buildRequest(plans.find((p: any) => p.outcome.kind === 'ready')!, pinned, cat, base.rungs[0], prompt);
      S[format] = Math.ceil(JSON.stringify({ ...body, messages: [] }).length / 4);
    }
    const capPath = join(TREE, 'config/cap.json');
    writeFileSync(capPath, JSON.stringify({ ...base.cap, S }, null, 2));
    base.cap = json(capPath);
    const out: Record<string, string> = {};
    for (const [name, i] of Object.entries(f)) {
      const r = await preview({ prompt, promptId: PROMPT_ID, format: i.format as any }, { ...base, inputs: { ...inputsOf(i), cat } } as any);
      out[name] = r.sha256;
      console.log(`preview ${name}: ${r.sha256.slice(0, 12)} commit $${r.body.sum_commit_usd.toFixed(4)} ${JSON.stringify(Object.fromEntries(r.body.plans.map((p: any) => [p.customer_id.slice(0, 12), p.admission?.code ?? p.admission?.action ?? p.outcome.code])))}`);
    }
    return { S, sha: out };
  } finally { await proxy.dispose(); }
}

// ---- drive ----
type F = ReturnType<typeof inputs>;
interface Ctx { state: string; f: F; id: (s: string) => string; calls: Call[]; stub: StubOptions; sha: Record<string, string> }
const shaOf = (c: Ctx, f: Input) => c.sha[Object.entries(c.f).find(([, v]) => v === f)![0]]!;
async function start(c: Ctx, id: string, f: Input) {
  const r = await post('/api/runs', runBody(id, 'isolation', f, shaOf(c, f)));
  if (!r.ok) throw new Error(`POST /api/runs ${r.status} ${await r.text()}`);
}
const within = <T>(p: Promise<T>, what: string) => Promise.race([p, sleep(POLL_S * 1000).then(() => { throw new Error(`no ${what} in ${POLL_S}s`); })]);
const openOf = (state: string, id: string) => unitsOf(state, id).filter((u) => !['drafted', 'failed', 'skipped'].includes(u.status)).length;
/** Kill at the 7th answer. Green: restart. Red: skip the restart and rerun the customers as a new run, which is what a resume must not be. `busy`: 429 one in-flight key after the kill, so it alone is called twice. */
async function driveR1(c: Ctx, red = false, busy = false) {
  const id = c.id(red ? 'r1-red' : 'r1'); let dev = await up(c.state); let killed!: () => void;
  let mark = 0, called_before: string[] = [];
  const at7 = new Promise<void>((ok) => { killed = ok; });
  c.calls.length = 0;
  c.stub.onAnswer = (_, n) => { if (n >= 7) { c.stub.onAnswer = undefined; mark = c.calls.length; called_before = [...new Set(c.calls.map((x) => x.key))]; killTree(dev); killed(); } };   // >=: calls overlap, so the count can step past 7
  await start(c, id, c.f.dur);
  await within(at7, 'the 7th answer');
  await sleep(1000);
  const finished = unitsOf(c.state, id).filter((u) => u.status === 'drafted').map((u) => u.key);
  if (busy) c.stub.busy = new Set(called_before.filter((k) => !finished.includes(k)).slice(0, 1));
  dev = await up(c.state);
  if (red) { const again = `${id}-new`; await start(c, again, c.f.dur); await done(c.state, again); }
  else { const r = await post(`/api/runs/${id}/restart`, {}); if (!r.ok) throw new Error(`restart ${r.status} ${await r.text()}`); await done(c.state, id); }
  killTree(dev);
  const calls_after: Record<string, number> = {};
  for (const x of c.calls.slice(mark)) calls_after[x.key] = (calls_after[x.key] ?? 0) + 1;
  const billed = sql(c.state, `SELECT customer_id key, billed_attempts b FROM units WHERE run_id=${q(id)} AND billed_attempts > 1`);
  return { finished, called_before, calls_after, open: openOf(c.state, id), billed_twice: billed };
}
/** Green: hold d03 after its answer, kill, restart. Red: no fault and no kill, so attempt 1 settles as answered. */
async function driveR2(c: Ctx, red = false) {
  const id = c.id(red ? 'r2-red' : 'r2'); let dev = await up(c.state, red ? undefined : 'pause_after_answer:d03');
  c.calls.length = 0;
  if (red) { await start(c, id, c.f.dur); await done(c.state, id); killTree(dev); }
  else {
    const seen = new Promise<void>((ok) => { c.stub.onAnswer = (k) => { if (k === 'd03') ok(); }; });
    await start(c, id, c.f.dur);
    await within(seen, 'd03 answered'); c.stub.onAnswer = undefined;
    await sleep(3000);   // answered; gen now holds before its write
    killTree(dev);
    await sleep(1000);
    dev = await up(c.state);
    const r = await post(`/api/runs/${id}/restart`, {});
    if (!r.ok) throw new Error(`restart ${r.status} ${await r.text()}`);
    await done(c.state, id);
    killTree(dev);
  }
  const rows = sql(c.state, `SELECT attempt, call_state FROM cost_events WHERE run_id=${q(id)} AND customer_id='d03' ORDER BY attempt`);
  return { attempt1: rows[0]?.call_state ?? null, attempts: rows.length, calls: c.calls.filter((x) => x.key === 'd03').length, rows };
}
async function driveR4(c: Ctx, fault: string | undefined, state: string) {
  const id = c.id(fault ? 'r4' : 'r4-red'), dev = await up(state, fault);
  try { await start(c, id, c.f.isolation); await done(state, id); } finally { killTree(dev); }
  return { expected: json(join(ISO, 'expected.synthetic.json')).expected, units: Object.fromEntries(unitsOf(state, id).map((u) => [u.key, u.code ? `${u.status}:${u.code}` : u.status])) };
}
async function driveR5(c: Ctx, f: Input, tag: string) {
  const id = c.id(tag), dev = await up(c.state);
  c.calls.length = 0;
  await start(c, id, f); await done(c.state, id); killTree(dev);
  const u = sql(c.state, `SELECT customer_id key, status, code, billed_attempts b FROM units WHERE run_id=${q(id)}`);
  const d = sql(c.state, `SELECT version, model_json FROM drafts WHERE run_id=${q(id)} AND customer_id='xbad' ORDER BY version`);
  const email = (i: number) => (d[i] ? JSON.stringify(JSON.parse(d[i].model_json).email) : null);
  return { b429: u.find((x) => x.key === 'x429')?.b, refusal_calls: c.calls.filter((x) => x.key === 'xrefuse').length,
    retry_parts: (c.calls.find((x) => x.key.startsWith('xbad') && x.n === 2)?.parts ?? null), carried_same: d.length === 2 && email(0) === email(1), max_billed: Math.max(...u.map((x) => x.b)), units: u, calls: c.calls.slice() };
}
/** Red: the stub's count_tokens under-reports, so the oversized row is admitted and called. */
async function driveR6(c: Ctx, red = false) {
  const id = c.id(red ? 'r6-red' : 'r6'), dev = await up(c.state);
  c.calls.length = 0;
  const cap_in_body = (await post('/api/runs', { ...runBody(c.id(red ? 'r6-cap-red' : 'r6-cap'), 'isolation', c.f.cap, shaOf(c, c.f.cap)), cap_run_usd: 1 })).status;
  if (red) c.stub.count = () => 1000;
  await start(c, id, c.f.cap); await done(c.state, id); killTree(dev);
  c.stub.count = undefined;
  const big = unitsOf(c.state, id).find((u) => u.key === 'big');
  const ev = sql(c.state, `SELECT action, charged_usd FROM cost_events WHERE run_id=${q(id)} AND customer_id='big'`)[0];
  return { big: big ? `${big.status}:${big.code}` : null, big_calls: c.calls.filter((x) => x.key === 'big').length, big_charged: ev?.charged_usd ?? 0, big_action: ev?.action ?? null, cap_in_body };
}
/** Uses the finished R5 run. Green on x429, which is in_review. Red on xfail, whose draft the stub failed: the gate must refuse it, so nothing is approved or served. */
async function driveGate(c: Ctx, key: string) {
  const dev = await up(c.state), id = c.id('r5'), draft = sql(c.state, `SELECT id FROM drafts WHERE run_id=${q(id)} AND customer_id=${q(key)} ORDER BY version`)[0].id, path = (a: string) => `/api/drafts/${draft}/${a}`;
  const release_in_review = (await post(path('release'), {})).status;
  let status_update = 'applied';
  try { sql(c.state, `UPDATE drafts SET status='released' WHERE id=${q(draft)}`); } catch (e: any) { status_update = /CHECK constraint failed/.test(`${e.stdout}${e.stderr}`) ? 'refused' : `error: ${e.message}`; }
  const approve = [(await post(path('approve'), {})).status, (await post(path('approve'), {})).status];
  const release = [(await post(path('release'), {})).status, (await post(path('release'), {})).status];
  const events = (to: string) => sql(c.state, `SELECT COUNT(*) n FROM draft_events WHERE draft_id=${q(draft)} AND to_status='${to}'`)[0].n;
  const released = async () => (await fetch(url(`/released/${draft}?part=email`))).status;
  const released_before = await released();
  let tamper = 'applied';
  try { sql(c.state, `UPDATE drafts SET rendered_json = rendered_json || ' ' WHERE id=${q(draft)}`); } catch (e: any) { tamper = `refused: ${`${e.stdout}${e.stderr}`.trim().split('\n').at(-1)}`; }
  const released_after = await released();
  const second_post = (await post('/api/runs', runBody(id, 'isolation', c.f.retry, shaOf(c, c.f.retry)))).status;
  killTree(dev);
  return { gate: { release_in_review, status_update, approve, release, released_before, tamper, released_after },
    idem: { second_post, approve_events: events('approved'), release_events: events('released'), draft_id: draft, want_draft_id: `${id}:${key}:v1` } };
}
const evidenceR7 = (state: string, id: string) => ({ status: sql(state, `SELECT status FROM runs WHERE id=${q(id)}`)[0]?.status,
  units: sql(state, `SELECT u.customer_id key, u.status, u.code, d.id draft FROM units u LEFT JOIN drafts d ON d.run_id=u.run_id AND d.customer_id=u.customer_id AND d.version=1 WHERE u.run_id=${q(id)}`) });
/** Red: hold one customer, then mark the run stopped, so a run ends with open units. */
async function driveR7Red(c: Ctx) {
  const id = c.id('r7-red'), dev = await up(c.state, 'pause_after_answer:c-ok-2');
  c.calls.length = 0;
  const seen = new Promise<void>((ok) => { c.stub.onAnswer = (k) => { if (k === 'singapore') ok(); }; });
  await start(c, id, c.f.isolation);
  await within(seen, 'c-ok-2 answered'); c.stub.onAnswer = undefined;
  await sleep(1000);
  const r = await post(`/api/runs/${id}/mark-stopped`, { reason: 'readiness: red run' });
  if (!r.ok) throw new Error(`mark-stopped ${r.status} ${await r.text()}`);
  killTree(dev);
  return evidenceR7(c.state, id);
}

// ---- patched runs, line 4 only ----
// No fault or stub reaches the gate, so each rung patches out/readiness/tree for one wrangler, or rebuilds `drafts` from migrations/0001_core.sql minus named CHECKs in a throwaway copy of the state.
// The tree is restored from src after each rung and must match before the green drive. Rungs drop one more layer each, so the report shows what actually held.
const STATE_TS = 'src/lib/state/index.ts', REVIEW_TS = 'src/worker/routes/review.ts';
type Patch = [file: string, from: string, to: string];
const NO_EDGE_CHECK: Patch = [STATE_TS, 'if (!d || d.status !== e.from || !e.who.includes(actor.kind)) return wrong();', 'if (!d || !e.who.includes(actor.kind)) return wrong();'];
const NO_SQL_STATUS: Patch[] = [[STATE_TS, 'WHERE id = ? AND status = ? ${guard}`)', 'WHERE id = ? ${guard}`)'], [STATE_TS, '...head[1], draft_id, e.from, ...(guard', '...head[1], draft_id, ...(guard']];
const NO_E7_GUARD: Patch = [STATE_TS, "edge === 'E7' ? 'AND approved_sha256 = ? AND content_sha256 = approved_sha256' : ''", "''"];
const NO_RELEASED_HASH: Patch = [REVIEW_TS, "if (await contentSha256(row.envelope_json, row.model_json, row.rendered_json) !== row.approved_sha256) return fail(409, 'HASH_MISMATCH');\n  const body", 'const body'];
const CK_APPROVED = "  CHECK ((status IN ('approved','released')) = (approved_by IS NOT NULL AND approved_sub IS NOT NULL\n                                               AND approved_at IS NOT NULL AND approved_sha256 IS NOT NULL)),\n";
const CK_RELEASED = "  CHECK ((status = 'released') = (released_by IS NOT NULL AND released_at IS NOT NULL)),\n";
interface Rung { id: string; clause: string; open: (g: any) => boolean; must?: boolean; code: Patch[]; ddl: string[] }
const stateOpen = (g: any) => g.release_in_review === 200, ddlOpen = (g: any) => g.status_update === 'applied', hashOpen = (g: any) => g.released_after === 200;
const STATE = 'release on in_review', DDL = 'status-only UPDATE', HASH = '/released still 200';
export const RUNGS: Rung[] = [
  { id: 'state-1-edge-check', clause: STATE, open: stateOpen, code: [NO_EDGE_CHECK], ddl: [] },
  { id: 'state-2-sql-status', clause: STATE, open: stateOpen, code: [NO_EDGE_CHECK, ...NO_SQL_STATUS], ddl: [] },
  { id: 'state-3-e7-guard', clause: STATE, open: stateOpen, code: [NO_EDGE_CHECK, ...NO_SQL_STATUS, NO_E7_GUARD], ddl: [] },
  { id: 'state-4-ddl-approved', clause: STATE, open: stateOpen, must: true, code: [NO_EDGE_CHECK, ...NO_SQL_STATUS, NO_E7_GUARD], ddl: [CK_APPROVED] },
  { id: 'ddl-1-approved', clause: DDL, open: ddlOpen, code: [], ddl: [CK_APPROVED] },
  { id: 'ddl-2-released', clause: DDL, open: ddlOpen, must: true, code: [], ddl: [CK_APPROVED, CK_RELEASED] },
  { id: 'hash-1-released-route', clause: HASH, open: hashOpen, must: true, code: [NO_RELEASED_HASH], ddl: [] },
];
const treeDiff = () => ['src', 'migrations'].map((d) => spawnSync('diff', ['-rq', join(ROOT, d), join(TREE, d)], { encoding: 'utf8' }).stdout).join('');
function patchTree(code: Patch[]) {
  const text = new Map<string, string>();
  for (const [file, from, to] of code) {
    const t = text.get(file) ?? readFileSync(join(TREE, file), 'utf8');
    if (!t.includes(from)) throw new Error(`patch no longer applies: ${from}`);
    text.set(file, t.replace(from, () => to));
  }
  for (const [file, t] of text) writeFileSync(join(TREE, file), t);
  return [...text.keys()];
}
/** What the patched migration would have built, on the rows that exist. */
function rebuildDrafts(state: string, drop: string[]) {
  const m = /CREATE TABLE drafts \([\s\S]*?approved_sha256 = content_sha256\)\);/.exec(readFileSync(join(ROOT, 'migrations/0001_core.sql'), 'utf8'));
  if (!m) throw new Error('drafts DDL not found');
  let ddl = m[0];
  for (const d of drop) { if (!ddl.includes(d)) throw new Error(`DDL patch no longer applies: ${d}`); ddl = ddl.replace(d, ''); }
  const file = `${state}.rebuild.sql`;
  writeFileSync(file, `${ddl.replace('CREATE TABLE drafts', 'CREATE TABLE drafts_x')}\nINSERT INTO drafts_x SELECT * FROM drafts;\nDROP TABLE drafts;\nALTER TABLE drafts_x RENAME TO drafts;\nCREATE UNIQUE INDEX one_live ON drafts(run_id, customer_id) WHERE status IN ('in_review','approved','released');\n`);
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'nicobar', '--local', '--persist-to', state, '--file', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(file);
}
/** The real driveGate on x429, on a copy of the state, on the patched tree. The tree comes back from src whatever happens. */
async function driveRung(c: Ctx, r: Rung): Promise<ClauseRed> {
  const state = join(OUT, `state-${r.id}`);
  const out = { line: 'L4', clause: r.clause, via: `${r.id}: patched ${[...new Set(r.code.map((p) => p[0]))].join(', ') || 'no code'}; dropped ${r.ddl.length} DDL CHECK`, must: !!r.must };
  cpSync(c.state, state, { recursive: true });
  try {
    if (r.ddl.length) rebuildDrafts(state, r.ddl);
    patchTree(r.code);
    const { gate } = await driveGate({ ...c, state }, 'x429');
    return { ...out, opened: r.open(gate), failures: L4(gate), evidence: gate };
  } catch (e) {
    for (const p of [...live]) killTree(p);
    return { ...out, opened: false, failures: [], evidence: { error: (e as Error).message } };
  } finally {
    for (const f of new Set(r.code.map((p) => p[0]))) cpSync(join(ROOT, f), join(TREE, f));
    rmSync(state, { recursive: true, force: true });
  }
}
/** R2 and R5's call-count clauses: the stub 429s a key's first call, so a real run makes one call more than the assertion allows. Shows the count reads real calls. A step retry under one row is the design, not a fault. */
async function driveBusy(c: Ctx, stub: StubOptions, line: string, clause: string, key: string, check: Check, drive: (x: Ctx) => Promise<any>): Promise<ClauseRed> {
  const out = { line, clause, via: `stub: first call for ${key} is a 429`, must: true };
  stub.busy = key.startsWith('one ') ? undefined : new Set([key]);
  try {
    const e = await drive({ ...c, id: (x) => c.id(`${x}-busy`) }), failures = check(e);
    return { ...out, opened: failures.length > 0 && failures.every((f) => f.startsWith(clause)), failures, evidence: e };
  } catch (e) { for (const p of [...live]) killTree(p); return { ...out, opened: false, failures: [], evidence: { error: (e as Error).message } }; }
  finally { stub.busy = undefined; }
}
function withClauses(l: Line, all: ClauseRed[]): Line {
  const mine = all.filter((c) => c.line === l.id), closed = mine.filter((c) => c.must && !c.opened).map((c) => c.via);
  return { ...l, clause_reds: mine, ...(l.verdict === 'PASS' && closed.length ? { verdict: 'VOID' as const, why: `clause not seen red: ${closed.join('; ')}` } : {}) };
}

const IDS = Object.keys(PLANTED);
function report(lines: Line[], s_for_stub?: unknown) {
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  const counts = { PASS: 0, FAIL: 0, VOID: 0 };
  for (const l of lines) { counts[l.verdict]++; console.log(`${l.verdict} ${l.id}: ${l.why}`); }
  writeFileSync(join(ROOT, 'reports/readiness.json'), `${JSON.stringify({ synthetic: true, paid_calls: 0, s_for_stub, counts, lines }, null, 1)}\n`);
  return counts;
}
/** Green evidence and seam evidence are each `{e}` or `{error}`. An error is no evidence: VOID. */
type Got = { e: any } | { error: string };
const tryDrive = async (f: () => Promise<any>): Promise<Got> => {
  try { return { e: await f() }; } catch (e) { for (const p of [...live]) killTree(p); return { error: (e as Error).message }; } };
function verdict(id: string, got: Got, seam: Got, proof: ReturnType<typeof plantedProof>): Line {
  const red = `planted: ${PLANTED[id]!.bad.length} bad, ${proof[id]!.ok ? 'all failed' : 'NOT all failed'}`;
  const check = PLANTED[id]!.check;
  const seam_red = 'e' in seam ? check(seam.e) : [];
  const base = { id, red, seam_red, output: 'e' in got ? got.e : null, seam_output: 'e' in seam ? seam.e : null };
  if ('error' in got) return { ...base, verdict: 'VOID', why: `green drive stopped: ${got.error}` };
  if ('error' in seam) return { ...base, verdict: 'VOID', why: `seam drive stopped: ${seam.error}` };
  if (!proof[id]!.ok) return { ...base, verdict: 'VOID', why: 'assertion not seen red on planted evidence' };
  if (!seam_red.length) return { ...base, verdict: 'VOID', why: 'seam run did not go red' };
  const broken = check(got.e);
  return { ...base, verdict: broken.length ? 'FAIL' : 'PASS', why: broken.join('; ') || 'held on the real run' };
}

async function main() {
  const proof = plantedProof();
  for (const [id, p] of Object.entries(proof)) console.log(`planted ${id}: good ${p.good.length ? 'BROKE' : 'holds'}; ${p.reds.map((r) => r[0] ?? 'NOT CAUGHT').join(' | ')}`);
  if (Object.values(proof).some((p) => !p.ok)) process.exitCode = 1;
  if (process.argv.includes('--selftest')) return;
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(TREE, { recursive: true });
  writeFileSync(join(OUT, 'empty.env'), '');
  for (const p of ['src', 'config', 'data', 'reports', 'migrations', 'scripts', 'wrangler.jsonc', 'package.json', 'tsconfig.json', 'worker-configuration.d.ts']) cpSync(join(ROOT, p), join(TREE, p), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(TREE, 'node_modules'));
  const voidAll = (why: string) => { process.exitCode = 1; report(IDS.map((id) => ({ id, verdict: 'VOID', why, red: `planted: ${proof[id]!.ok ? 'all failed' : 'NOT all failed'}`, seam_red: [], output: null, seam_output: null }))); };
  const steps: [string, string[]][] = [['migrate', ['wrangler', 'd1', 'migrations', 'apply', 'nicobar', '--local']],
    ['build', ['node', 'scripts/build.ts', '--publish']]];
  for (const [name, cmd] of steps) {
    const r = spawnSync(cmd[0] === 'wrangler' ? 'npx' : cmd[0]!, cmd[0] === 'wrangler' ? cmd : cmd.slice(1), { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return voidAll(`prerequisite ${name}: ${`${r.stderr}${r.stdout}`.trim().split('\n').at(-1)}`);
  }
  const main = join(ROOT, '.wrangler/state'), scratch = join(OUT, 'state');
  const calls: Call[] = [], stub: StubOptions = { calls, delayMs: 200 };
  const server = await startStub(STUB_PORT, stub);
  let lines: Line[];
  let measured: unknown;
  try {
    const seed = await up(main);
    const s = spawnSync('npm', ['run', 'config', 'seed'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONFIG_URL: url('') } });
    killTree(seed); await sleep(1000);
    if (s.status !== 0) return voidAll(`prerequisite config seed: ${`${s.stderr}${s.stdout}`.trim().split('\n').at(-1)}`);
    const f = inputs(liveOf(main));
    const { S, sha } = await previewAll(f, main);
    measured = { S, cap_json_S: json(join(ROOT, 'config/cap.json')).S };
    console.log(`S for the stub, drive only: ${JSON.stringify(S)}`);
    cpSync(main, scratch, { recursive: true });
    const ts = Date.now().toString(36);
    const c: Ctx = { state: scratch, f, id: (x) => `stub-${ts}-${x}`, calls, stub, sha };
    const step = async (name: string, fn: () => Promise<any>) => { console.log(`drive ${name} ${new Date().toISOString().slice(11, 19)}`); const g = await tryDrive(fn); console.log(`  ${JSON.stringify(g).slice(0, 600)}`); return g; };
    // R4's real run lands on the default state, so it can be seeded on /review. Everything else stays on the scratch copy.
    const r4red = await step('R4 red: no DEV_FAULT', () => driveR4(c, undefined, scratch));
    const r4 = await step('R4', () => driveR4({ ...c, state: main }, 'throw:c-throw', main));
    const r7 = await step('R7', async () => evidenceR7(main, c.id('r4')));
    const r7red = await step('R7 red: pause, mark-stopped', () => driveR7Red(c));
    const r1red = await step('R1 red: new run instead of restart', () => driveR1(c, true));
    const r1 = await step('R1', () => driveR1(c));
    // the in-flight clause alone: only the new clause may fire on this run
    const inflight = await driveBusy(c, stub, 'R1', 'in-flight', 'one in-flight key', R1, (x) => driveR1(x, false, true));
    console.log(JSON.stringify([inflight.clause, inflight.opened, inflight.failures]));
    const r2red = await step('R2 red: no pause, no kill', () => driveR2(c, true));
    const r2 = await step('R2', () => driveR2(c));
    const r5 = await step('R5', () => driveR5(c, c.f.retry, 'r5'));
    const r5red = await step('R5 red: stub answers worse', () => driveR5(c, c.f.retryRed, 'r5-red'));
    const gRed = await step('R3+L4 red: gate on a failed draft', () => driveGate(c, 'xfail'));
    const reds: ClauseRed[] = [inflight];
    for (const r of RUNGS) { console.log(`rung ${r.id} ${new Date().toISOString().slice(11, 19)}`); const x = await driveRung(c, r); reds.push(x); console.log(`  opened ${x.opened}: ${x.failures.join('; ')} ${JSON.stringify(x.evidence).slice(0, 400)}`); }
    reds.push(await driveBusy(c, stub, 'R2', 'stub calls = attempt rows', 'd03', R2, driveR2));
    reds.push(await driveBusy(c, stub, 'R5', 'refusal stub calls', 'xrefuse', R5, (x) => driveR5(x, c.f.retry, 'r5')));
    console.log(JSON.stringify(reds.slice(-2).map((x) => [x.clause, x.opened, x.failures])));
    const tree_diff_before_green = treeDiff();
    console.log(`tree against src before green: ${tree_diff_before_green || 'identical'}`);
    const g = await step('R3+L4', async () => { if (tree_diff_before_green) throw new Error(`tree not restored: ${tree_diff_before_green}`); return driveGate(c, 'x429'); });
    const part = (x: Got, k: 'gate' | 'idem'): Got => ('e' in x ? { e: x.e[k] } : x);
    const r6 = await step('R6', () => driveR6(c));
    const r6red = await step('R6 red: count_tokens under-reports', () => driveR6(c, true));
    lines = [verdict('R1', r1, r1red, proof), verdict('R2', r2, r2red, proof), verdict('R3', part(g, 'idem'), part(gRed, 'idem'), proof), verdict('R4', r4, r4red, proof), verdict('R5', r5, r5red, proof),
      verdict('R6', r6, r6red, proof), verdict('R7', r7, r7red, proof), verdict('L4', part(g, 'gate'), part(gRed, 'gate'), proof)].map((l) => withClauses(l, reds));
  } catch (e) {
    return voidAll(`drive stopped: ${(e as Error).message}`);
  } finally { server.close(); for (const p of [...live]) killTree(p); }
  const n = report(lines, measured);
  if (n.FAIL || n.VOID) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
