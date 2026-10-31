// `npm run readiness`: R1–R7 and line 4 on a real local `wrangler dev` against a scripted Messages stub. $0, no key, no remote.
// `--selftest` runs only the planted evidence. A line is PASS only if its assertion was seen failing on planted bad evidence in this
// same process and held on the real run; a prerequisite that is not built makes it VOID, never PASS. reports/readiness.json is rewritten each time.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'out/readiness');
const ISO = join(ROOT, 'test/fixtures/isolation');
const PORT = 8797, STUB_PORT = 8798, GEN_CONCURRENCY = 4, POLL_S = 180;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ---- verdicts, pure over evidence ----
export type Verdict = 'PASS' | 'FAIL' | 'VOID';
export interface Line { id: string; verdict: Verdict; why: string; red: string; output: unknown }
type Check = (e: any) => string[];   // returns the broken facts; [] holds
const eq = (name: string, got: unknown, want: unknown) => (got === want ? [] : [`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`]);

/** R1. finished: drafted before the kill. calls_after: stub calls per key after the kill. */
const R1: Check = (e) => [
  ...Object.keys(e.calls_after).filter((k) => e.finished.includes(k)).map((k) => `finished ${k} called again`),
  ...eq('every unit terminal', e.open, 0),
  ...(Object.keys(e.calls_after).length > GEN_CONCURRENCY ? [`${Object.keys(e.calls_after).length} in-flight repeats > ${GEN_CONCURRENCY}`] : []),
];
/** R2. A pause, a kill, a restart: attempt 1 is possibly_billed, and each stub call has its own attempt row. */
const R2: Check = (e) => [...eq('attempt 1 call_state', e.attempt1, 'possibly_billed'), ...eq('stub calls = attempt rows', e.calls, e.attempts)];
const R3: Check = (e) => [...eq('second POST', e.second_post, 409), ...eq('approve events', e.approve_events, 1), ...eq('release events', e.release_events, 1),
  ...eq('draft id', e.draft_id, e.want_draft_id)];
/** R4. units: key → 'status[:code]'. Each failure sits alone; `row:*` matches by prefix, because 46 leaves n open. */
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
  R1: { check: R1, good: { finished: ['d01'], calls_after: { d02: 1 }, open: 0 }, bad: [{ finished: ['d01'], calls_after: { d01: 1 }, open: 0 },
    { finished: [], calls_after: { a: 1, b: 1, c: 1, d: 1, e: 1 }, open: 0 }, { finished: [], calls_after: {}, open: 1 }] },
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

// ---- scripted Messages stub. scripts/stub-llm.ts answers every customer with one draft, so no 6-pick or shaped row can pass on it ----
interface Call { key: string; parts: string; n: number; status: number }
/** Answers come from layout.json's known-good drafts, one per occasion; occasion_key is null, as isolation rows have no row key. */
export function scriptedStub(onAnswer: (key: string, answered: number) => void) {
  const good = (id: string) => json(join(ROOT, 'test/cases/layout.json')).cases.find((c: any) => c.id === id).draft;
  const stems: [RegExp, string][] = [[/birthday/, 'GOOD-c16'], [/trip/, 'GOOD-c18'], [/Diwali/, 'GOOD-c07'], [/wedding/, 'GOOD-c01'], [/Monsoon/, 'GOOD-c02-both']];
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const body = JSON.parse(raw), input_tokens = Math.ceil(raw.length / 4);
    if (req.url === '/v1/messages/count_tokens') return send(200, { input_tokens });
    const occ = /<occasion>(.*?)<\/occasion>/.exec(JSON.stringify(body.messages))?.[1] ?? '';
    const key = occ.split(' ').at(-1)!;
    const schema = body.output_config?.format?.schema ?? {};
    const parts = schema.required?.includes('email') ? 'both' : schema.properties?.sections ? 'landing_page' : 'email';
    const n = calls.filter((c) => c.key === key).length + 1;
    const base = { id: `msg_rd_${key}_${n}`, type: 'message', role: 'assistant', model: body.model, stop_sequence: null };
    const log = (status: number) => calls.push({ key, parts, n, status });
    if (key.startsWith('x429') && n === 1) { log(429); return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'stub' } }); }
    log(200);
    if (key.startsWith('xrefuse')) return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, usage: { input_tokens, output_tokens: 0 } });
    await sleep(200);   // holds calls open, so a kill finds some in flight
    const d = structuredClone(good(stems.find(([re]) => re.test(occ))?.[1] ?? 'GOOD-c16'));
    for (const v of Object.values<any>(d)) v.occasion_key = null;
    if (key.startsWith('xbad') && n === 1) d.landing_page.sections[0].line += ' Now 20% off.';
    const text = JSON.stringify(parts === 'both' ? d : d[parts]);
    onAnswer(key, calls.filter((c) => c.status === 200).length);
    send(200, { ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens, output_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  });
  return { calls, listen: () => new Promise<void>((ok) => server.listen(STUB_PORT, '127.0.0.1', ok)), close: () => server.close() };
}

// ---- wrangler ----
/** detached makes wrangler a group leader; the group held all 6 processes including both workerd [verified 2026-11-01]. Killing less leaves an orphan that fakes a resume. */
function killTree(p: ChildProcess) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } }
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
async function up(state: string, fault?: string): Promise<ChildProcess> {
  // --env-file: an empty file stops wrangler loading .dev.vars, so no real key can reach this run [verified 2026-11-01]
  const vars = { DEV_MODE: '1', DEV_ACTOR: 'readiness@local', ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, ...(fault ? { DEV_FAULT: fault } : {}) };
  const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', state, '--env-file', join(OUT, 'empty.env'),
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: ROOT, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) { if (await fetch(url('/review')).catch(() => null)) return dev; await sleep(500); }
  killTree(dev); throw new Error('wrangler did not come up');
}
const sql = (state: string, command: string): any[] => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'nicobar', '--local', '--persist-to', state, '--json', '--command', command],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0].results;
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const post = (path: string, body: unknown) => fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', origin: url('').replace(/\/$/, '') }, body: JSON.stringify(body) });
async function done(state: string, id: string, want = ['done', 'stopped']) {
  for (let i = 0; i < POLL_S / 2; i++) { const s = sql(state, `SELECT status FROM runs WHERE id=${q(id)}`)[0]?.status; if (want.includes(s)) return s; await sleep(2000); }
  throw new Error(`run ${id} not finished in ${POLL_S}s`);
}
const unitsOf = (state: string, id: string) => sql(state, `SELECT customer_id key, status, code FROM units WHERE run_id=${q(id)}`);

// ---- inputs, generated under out/ from the isolation rows, so every pick stays a real one ----
const OCC = ["Mother's birthday", 'Work trip to Singapore', 'Diwali at home', "Sister's wedding"];
const HEAD = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\n';
function writeInput(name: string, rows: { id: string; occ: string; picks: unknown[] }[]) {
  const tsv = join(OUT, `${name}.synthetic.tsv`), recs = join(OUT, `${name}.recs.synthetic.json`), base = json(join(ISO, 'recommendations.synthetic.json'));
  writeFileSync(tsv, HEAD + rows.map((r) => `${r.id}\tTest\tSynthetic\t${r.occ}\tBought a test item.\n`).join(''));
  writeFileSync(recs, JSON.stringify({ ...base, rule: `readiness ${name}`, rows: rows.map((r) => ({ customer_id: r.id, picks: r.picks })) }));
  return { tsv, recs };
}
export function inputs() {
  const iso = json(join(ISO, 'recommendations.synthetic.json')).rows;
  const c02 = json(join(ROOT, 'data/recommendations.synthetic.json')).rows.find((r: any) => r.customer_id === 'c02').picks;
  const picks = (n: number) => iso.find((r: any) => r.customer_id === `c-ok-${n % 4 + 1}`).picks;
  const d = (i: number) => `d${String(i + 1).padStart(2, '0')}`;
  return {
    dur: writeInput('durability', Array.from({ length: 12 }, (_, i) => ({ id: d(i), occ: `${OCC[i % 4]} ${d(i)}`, picks: picks(i) }))),
    retry: writeInput('retry', ['x429', 'xbad', 'xrefuse'].map((k) => ({ id: k, occ: `Monsoon in Kochi ${k}`, picks: c02 }))),
    // U_hard is 26,760 tokens; about 4 characters a token, so 160 KB of occasion is over it on any tokenizer
    cap: writeInput('cap', [{ id: 'big', occ: `${'Diwali at home '.repeat(11_000)}big`, picks: picks(2) }, { id: 'ok1', occ: 'Diwali at home ok1', picks: picks(2) }]),
    isolation: { tsv: join(ISO, 'customers.synthetic.tsv'), recs: join(ISO, 'recommendations.synthetic.json') },
  };
}
/** [unknown] 46 defines no body; LLD:1400 lists its fields only. Settle this and PREVIEW against `run` and `gen` at merge. */
const runBody = (id: string, stage: string, format: string, f: { tsv: string; recs: string }, preview: string) =>
  ({ id, stage, format, customers: readFileSync(f.tsv, 'utf8'), customers_synthetic: true, recs: json(f.recs), preview_sha256: preview, start_rung: 'sonnet' });
const PREVIEW = (f: { tsv: string; recs: string }, format: string) => execFileSync('node', ['scripts/preview.ts', '--customers', f.tsv, '--recs', f.recs, '--format', format], { cwd: ROOT, encoding: 'utf8' }).trim();

// ---- drive ----
type F = ReturnType<typeof inputs>;
interface Ctx { state: string; f: F; id: (s: string) => string; stub: ReturnType<typeof scriptedStub>; hook: { fn: (k: string, n: number) => void } }
async function start(c: Ctx, id: string, stage: string, format: string, f: { tsv: string; recs: string }) {
  const r = await post('/api/runs', runBody(id, stage, format, f, PREVIEW(f, format)));
  if (!r.ok) throw new Error(`POST /api/runs ${r.status} ${await r.text()}`);
}
async function driveR1(c: Ctx) {
  const id = c.id('r1'); let dev = await up(c.state); let killed!: () => void;
  const at7 = new Promise<void>((ok) => { killed = ok; });
  c.stub.calls.length = 0;
  c.hook.fn = (_, n) => { if (n === 7) { killTree(dev); killed(); } };
  await start(c, id, 'isolation', 'landing_page', c.f.dur);
  await at7; c.hook.fn = () => {};
  const mark = c.stub.calls.length;
  await sleep(1000);
  const finished = unitsOf(c.state, id).filter((u) => u.status === 'drafted').map((u) => u.key);
  dev = await up(c.state);
  await post(`/api/runs/${id}/restart`, {});
  await done(c.state, id);
  killTree(dev);
  const calls_after: Record<string, number> = {};
  for (const x of c.stub.calls.slice(mark)) calls_after[x.key] = (calls_after[x.key] ?? 0) + 1;
  return { finished, calls_after, open: unitsOf(c.state, id).filter((u) => !['drafted', 'failed', 'skipped'].includes(u.status)).length };
}
async function driveR2(c: Ctx) {
  const id = c.id('r2'); let dev = await up(c.state, 'pause_after_answer:d03');
  c.stub.calls.length = 0;
  const seen = new Promise<void>((ok) => { c.hook.fn = (k) => { if (k === 'd03') ok(); }; });
  await start(c, id, 'isolation', 'landing_page', c.f.dur);
  await seen; c.hook.fn = () => {};
  await sleep(3000);   // answered; gen now holds before its write
  killTree(dev);
  await sleep(1000);
  dev = await up(c.state);
  await post(`/api/runs/${id}/restart`, {});
  await done(c.state, id);
  killTree(dev);
  const rows = sql(c.state, `SELECT attempt, call_state FROM cost_events WHERE run_id=${q(id)} AND customer_id='d03' ORDER BY attempt`);
  return { attempt1: rows[0]?.call_state ?? null, attempts: rows.length, calls: c.stub.calls.filter((x) => x.key === 'd03').length };
}
async function driveR4(c: Ctx, fault: string | undefined, state: string) {
  const id = c.id(fault ? 'r4' : 'r4-red'), dev = await up(state, fault);
  try { await start({ ...c, state }, id, 'isolation', 'landing_page', c.f.isolation); await done(state, id); } finally { killTree(dev); }
  return { expected: json(join(ISO, 'expected.synthetic.json')).expected, units: Object.fromEntries(unitsOf(state, id).map((u) => [u.key, u.code ? `${u.status}:${u.code}` : u.status])) };
}
async function driveR5(c: Ctx) {
  const id = c.id('r5'), dev = await up(c.state);
  c.stub.calls.length = 0;
  await start(c, id, 'isolation', 'both', c.f.retry); await done(c.state, id); killTree(dev);
  const u = sql(c.state, `SELECT customer_id key, billed_attempts b FROM units WHERE run_id=${q(id)}`);
  const d = sql(c.state, `SELECT version, model_json FROM drafts WHERE run_id=${q(id)} AND customer_id='xbad' ORDER BY version`);
  const email = (i: number) => (d[i] ? JSON.stringify(JSON.parse(d[i].model_json).email) : null);
  return { b429: u.find((x) => x.key === 'x429')?.b, refusal_calls: c.stub.calls.filter((x) => x.key === 'xrefuse').length,
    retry_parts: c.stub.calls.find((x) => x.key === 'xbad' && x.n === 2)?.parts ?? null, carried_same: d.length === 2 && email(0) === email(1), max_billed: Math.max(...u.map((x) => x.b)) };
}
async function driveR6(c: Ctx) {
  const id = c.id('r6'), dev = await up(c.state);
  c.stub.calls.length = 0;
  const preview = PREVIEW(c.f.cap, 'landing_page');   // a real one, so the 400 cannot be a PREVIEW_STALE 409 in disguise
  const cap_in_body = (await post('/api/runs', { ...runBody(c.id('r6-cap'), 'isolation', 'landing_page', c.f.cap, preview), cap_run_usd: 1 })).status;
  await start(c, id, 'isolation', 'landing_page', c.f.cap); await done(c.state, id); killTree(dev);
  const big = unitsOf(c.state, id).find((u) => u.key === 'big');
  const ev = sql(c.state, `SELECT action, charged_usd FROM cost_events WHERE run_id=${q(id)} AND customer_id='big'`)[0];
  return { big: big ? `${big.status}:${big.code}` : null, big_calls: c.stub.calls.filter((x) => x.key === 'big').length, big_charged: ev?.charged_usd ?? 0, big_action: ev?.action ?? null, cap_in_body };
}
/** Uses the finished R5 run: x429 is in_review. Line 4 and the event half of R3 share these two drafts. */
async function driveGate(c: Ctx) {
  const dev = await up(c.state), id = c.id('r5'), draft = sql(c.state, `SELECT id FROM drafts WHERE run_id=${q(id)} AND customer_id='x429'`)[0].id, path = (a: string) => `/api/drafts/${draft}/${a}`;
  const release_in_review = (await post(path('release'), {})).status;
  let status_update = 'applied';
  try { sql(c.state, `UPDATE drafts SET status='released' WHERE id=${q(draft)}`); } catch (e: any) { status_update = /CHECK constraint failed/.test(`${e.stdout}${e.stderr}`) ? 'refused' : `error: ${e.message}`; }
  await post(path('approve'), {}); await post(path('approve'), {});
  await post(path('release'), {}); await post(path('release'), {});
  const events = (to: string) => sql(c.state, `SELECT COUNT(*) n FROM draft_events WHERE draft_id=${q(draft)} AND to_status='${to}'`)[0].n;
  const released = async () => (await fetch(url(`/released/${draft}?part=email`))).status;
  const released_before = await released();
  sql(c.state, `UPDATE drafts SET rendered_json = rendered_json || ' ' WHERE id=${q(draft)}`);
  const released_after = await released();
  const second_post = (await post('/api/runs', runBody(id, 'isolation', 'both', c.f.retry, PREVIEW(c.f.retry, 'both')))).status;
  killTree(dev);
  return { gate: { release_in_review, status_update, released_before, released_after },
    idem: { second_post, approve_events: events('approved'), release_events: events('released'), draft_id: draft, want_draft_id: `${id}:x429:v1` } };
}
function evidenceR7(c: Ctx) {
  const id = c.id('r4');
  const status = sql(c.state, `SELECT status FROM runs WHERE id=${q(id)}`)[0]?.status;
  return { status, units: sql(c.state, `SELECT u.customer_id key, u.code, d.id draft FROM units u LEFT JOIN drafts d ON d.run_id=u.run_id AND d.customer_id=u.customer_id WHERE u.run_id=${q(id)}`) };
}

const IDS = Object.keys(PLANTED);
function report(lines: Line[]) {
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  const counts = { PASS: 0, FAIL: 0, VOID: 0 };
  for (const l of lines) { counts[l.verdict]++; console.log(`${l.verdict} ${l.id}: ${l.why}`); }
  writeFileSync(join(ROOT, 'reports/readiness.json'), `${JSON.stringify({ synthetic: true, paid_calls: 0, counts, lines }, null, 1)}\n`);
  return counts;
}
function verdict(id: string, evidence: unknown, proof: ReturnType<typeof plantedProof>): Line {
  const red = `planted: ${PLANTED[id]!.bad.length} bad, ${proof[id]!.ok ? 'all failed' : 'NOT all failed'}`;
  const broken = PLANTED[id]!.check(evidence);
  if (!proof[id]!.ok) return { id, verdict: 'VOID', why: 'assertion not seen red', red, output: evidence };
  return { id, verdict: broken.length ? 'FAIL' : 'PASS', why: broken.join('; ') || 'held on the real run', red, output: evidence };
}

async function main() {
  const proof = plantedProof();
  for (const [id, p] of Object.entries(proof)) console.log(`planted ${id}: good ${p.good.length ? 'BROKE' : 'holds'}; ${p.reds.map((r) => r[0] ?? 'NOT CAUGHT').join(' | ')}`);
  if (Object.values(proof).some((p) => !p.ok)) process.exitCode = 1;
  if (process.argv.includes('--selftest')) return;
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'empty.env'), '');
  const voidAll = (why: string) => { process.exitCode = 1; report(IDS.map((id) => ({ id, verdict: 'VOID', why, red: `planted: ${proof[id]!.ok ? 'all failed' : 'NOT all failed'}`, output: null }))); };
  const missing = ['scripts/preview.ts', 'scripts/seed.ts'].find((p) => !existsSync(join(ROOT, p)));
  // config seed goes through the local routes, so it runs inside a server on the default state, which is the state export-demo reads
  const steps: [string, string[]][] = [['migrate', ['wrangler', 'd1', 'migrations', 'apply', 'nicobar', '--local']],
    ['build', ['node', 'scripts/build.ts', '--from-cache', process.env.READINESS_CACHE ?? '/Users/hiteshnarwal/Desktop/nicobar/.agent/scout/cache', '--publish']]];
  for (const [name, cmd] of steps) {
    const r = spawnSync(cmd[0] === 'wrangler' ? 'npx' : cmd[0]!, cmd[0] === 'wrangler' ? cmd : cmd.slice(1), { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return voidAll(`prerequisite ${name}: ${`${r.stderr}${r.stdout}`.trim().split('\n').at(-1)}`);
  }
  if (missing) return voidAll(`prerequisite: ${missing} not merged`);
  const main = '.wrangler/state', scratch = join(OUT, 'state'), hook = { fn: (_: string, __: number) => {} };
  const stub = scriptedStub((k, n) => hook.fn(k, n));
  await stub.listen();
  const lines: Line[] = [];
  try {
    const seed = await up(join(ROOT, main));
    const s = spawnSync('npm', ['run', 'config', 'seed'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONFIG_URL: url('') } });
    killTree(seed); await sleep(1000);
    if (s.status !== 0) return voidAll(`prerequisite config seed: ${`${s.stderr}${s.stdout}`.trim().split('\n').at(-1)}`);
    cpSync(join(ROOT, main), scratch, { recursive: true });
    const ts = Date.now().toString(36);
    const c: Ctx = { state: scratch, f: inputs(), id: (x) => `rd-${ts}-${x}`, stub, hook };
    // R4's real run lands on the default state, so it can be seeded on /review (46 §3). Its red, no DEV_FAULT, stays on the scratch copy.
    const r4red = PLANTED.R4!.check(await driveR4(c, undefined, scratch));
    const r4 = await driveR4(c, 'throw:c-throw', join(ROOT, main));
    const r4Line = verdict('R4', r4, proof);
    r4Line.red += r4red.length ? `; seam: no DEV_FAULT → ${r4red.join('; ')}` : '; seam run did NOT go red';
    if (!r4red.length) r4Line.verdict = 'VOID';
    const r7 = evidenceR7({ ...c, state: join(ROOT, main) });
    const r1 = await driveR1(c), r2 = await driveR2(c), r5 = await driveR5(c), r6 = await driveR6(c), g = await driveGate(c);
    lines.push(verdict('R1', r1, proof), verdict('R2', r2, proof), verdict('R3', g.idem, proof), r4Line, verdict('R5', r5, proof), verdict('R6', r6, proof), verdict('R7', r7, proof), verdict('L4', g.gate, proof));
  } catch (e) {
    return voidAll(`drive stopped: ${(e as Error).message}`);
  } finally { stub.close(); }
  const n = report(lines);
  if (n.FAIL || n.VOID) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
