// J3, flag only. Transport is a stubbed `fetch`; no request leaves the machine. `expand` is gen's, so the fake stands in until it merges.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, DraftRow, J3Input, JevConfig, ModelJson } from '../../src/contracts/types.ts';
import { fxCatalog, fxEnvelope, fxModelJson, fxPlan } from '../fakes/index.ts';
import { flaggedQuestions, isFlagged, j3Input, jevPreflight, jevReserveOk, judgeDraft } from '../../src/lib/jev/index.ts';

vi.mock('../../src/lib/render/expand.ts', async () => {
  const { fakeLib } = await import('../fakes/index.ts');
  return { expand: fakeLib.expand };
});

const cfg = JSON.parse(readFileSync('config/jev.json', 'utf8')) as JevConfig;
const env = { JEV_API_KEY: 'test-key' } as AppEnv;
const input: J3Input = { email: 'The email.', landing_page: 'The page.', quote: null, picks: [{ title: 'A throw', facets: ['Home'] }],
  occasion: 'Diwali at home', occasion_key: 'diwali', new_user: false };

const row = (key: string, m: ModelJson = fxModelJson(key)): DraftRow => ({ id: `r:${key}:v1`, run_id: 'r', customer_id: key, version: 1, format: fxPlan(key).format,
  snapshot_id: 's', validator_version: 'fx', model: 'm', envelope_json: JSON.stringify(fxEnvelope(key)), model_json: JSON.stringify(m),
  rendered_json: '{"email":"<p>rendered</p>"}', content_sha256: 'h', checks_json: '[]', hard_failures: 0 });

const noul = (n: number) => ({ type: 'noul', noul: n });
const score = (p0: number, confidence: number) => ({ type: 'score', score: 1 - p0, confidence, legend: {}, probabilities: { 0: p0, 1: 1 - p0, 2: 0, 3: 0 } });
/** Every answer on its good side; override per question. */
const goodAnswers = (over: Record<string, unknown> = {}) => ({ names_unselected_product: noul(0.1), discount: noul(0.1), pressure: noul(0.1),
  claims_company: noul(0.1), claims_customer: noul(0.1), scene: noul(0.9), specific: score(0.1, 0.9), quiet: score(0.1, 0.9), ...over });
const badAnswers = () => goodAnswers({ names_unselected_product: noul(0.99), discount: noul(0.99), pressure: noul(0.99), claims_company: noul(0.99),
  claims_customer: noul(0.99), scene: noul(0.01), specific: score(0.99, 0.99), quiet: score(0.99, 0.99) });
const reply = (body: unknown = { model: cfg.model, answers: goodAnswers(), usage: { input_tokens: 1000, output_tokens: 18 } }, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const stubFetch = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  const f = vi.fn(fn);
  vi.stubGlobal('fetch', f);
  return f;
};
const sent = (f: ReturnType<typeof stubFetch>, n = 0) => JSON.parse(f.mock.calls[n][1].body as string);

afterEach(() => { vi.unstubAllGlobals(); });

describe('named 1: transport failures map to unavailable with a reason', () => {
  it.each([400, 401, 413, 415, 422, 500])('HTTP %i is not retried', async (status) => {
    const f = stubFetch(() => reply({}, status));
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ status: 'unavailable', reason: `http_${status}`, answers: null });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a network error', async () => {
    stubFetch(() => { throw new TypeError('connection reset'); });
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ status: 'unavailable', reason: 'network' });
  });
  it('the deadline passing on a hung request', async () => {
    stubFetch((_u, init) => new Promise((_, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason)); }));
    expect(await judgeDraft(env, input, { ...cfg, deadline_ms: 30 })).toMatchObject({ status: 'unavailable', reason: 'deadline' });
  });
  it('429 past the deadline', async () => {
    stubFetch(() => reply({}, 429));
    expect(await judgeDraft(env, input, { ...cfg, deadline_ms: 30 })).toMatchObject({ status: 'unavailable', reason: 'http_429' });
  });
  it.each([['not JSON', 'oops'], ['JSON null', 'null'], ['no answers', { model: cfg.model }],
    ['a question missing', { model: cfg.model, answers: { discount: noul(0.1) } }]])('a 200 with %s', async (_n, body) => {
    stubFetch(() => reply(body));
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ status: 'unavailable', reason: 'bad_response', answers: null });
  });
  it('no key means no request, and nothing charged', async () => {
    const f = stubFetch(() => reply());
    expect(await judgeDraft({} as AppEnv, input, cfg)).toMatchObject({ status: 'unavailable', reason: 'no_key', charged_usd: null });
    expect(f).not.toHaveBeenCalled();
  });
  it('429, then 529, then 200 is answered', async () => {
    let n = 0;
    const f = stubFetch(() => (++n === 1 ? reply({}, 429) : n === 2 ? reply({}, 529) : reply()));
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ status: 'answered', reason: null });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('a returned model other than the pinned one is a fallback, its answers unused', async () => {
    stubFetch(() => reply({ model: 'jev-9', answers: badAnswers(), usage: { input_tokens: 1000 } }));
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ status: 'model_mismatch', reason: 'model_mismatch', model: 'jev-9', answers: null, input_tokens: 1000 });
  });
});

describe('cost', () => {
  it('a sent request with no usage is charged the basis, never $0', async () => {
    stubFetch(() => reply({ model: cfg.model, answers: goodAnswers() }));
    expect(await judgeDraft(env, input, cfg)).toMatchObject({ input_tokens: null, charged_usd: cfg.basis_usd, basis_usd: cfg.basis_usd });
    stubFetch(() => reply({}, 401));
    expect((await judgeDraft(env, input, cfg)).charged_usd).toBe(cfg.basis_usd);
  });
  it('usage is priced by input tokens', async () => {
    stubFetch(() => reply());
    const out = await judgeDraft(env, input, cfg);
    expect(out.input_tokens).toBe(1000);
    expect(out.charged_usd).toBeCloseTo(0.000042, 9);
  });
});

describe('named 2: a flag never alters a check', () => {
  const deepFreeze = <T extends object>(o: T): T => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  it('judging holds no draft or database: frozen inputs pass through, the result carries no check field', async () => {
    const d = deepFreeze(row('fx-both'));
    const before = JSON.stringify(d);
    const j3 = deepFreeze(j3Input(d, fxPlan('fx-both'), fxCatalog()));
    stubFetch(() => reply({ model: cfg.model, answers: badAnswers(), usage: { input_tokens: 1 } }));
    const hot = { ...cfg, act: { discount: true } as unknown as JevConfig['act'] };   // the type forbids it; even so nothing acts
    const out = await judgeDraft(env, j3, hot);
    expect(flaggedQuestions(out.answers!, hot)).toHaveLength(8);
    expect(Object.keys(out).sort()).toEqual(['answers', 'basis_usd', 'charged_usd', 'input_tokens', 'model', 'reason', 'status']);
    expect(JSON.stringify(d)).toBe(before);
    expect(d.hard_failures).toBe(0);
  });
  it('the module names no check field', () => {
    expect(readFileSync('src/lib/jev/index.ts', 'utf8')).not.toMatch(/hard_failures|checks_json|transition|\.act\b/);
  });
});

describe('named 3: both parts labelled in one request', () => {
  it('one POST: each part under its own key, every question, polarity held back', async () => {
    const f = stubFetch(() => reply());
    await judgeDraft(env, j3Input(row('fx-both'), fxPlan('fx-both'), fxCatalog()), cfg);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    const body = sent(f);
    expect(body.model).toBe(cfg.model);
    const m = fxModelJson('fx-both');
    expect(body.state.email).toBe(JSON.stringify(m.email));
    expect(body.state.landing_page).toBe(JSON.stringify(m.landing_page));
    expect(body.state.email).not.toBe(body.state.landing_page);
    expect(Object.keys(body.questions)).toEqual(Object.keys(cfg.j3));
    expect(body.questions.scene).toEqual({ type: 'noul', instructions: cfg.j3.scene.instructions, criteria: cfg.j3.scene.criteria });
    expect(JSON.stringify(body.questions)).not.toContain('"bad"');
  });
  it('question text comes from the argument, not the bundled file', async () => {
    const f = stubFetch(() => reply());
    await judgeDraft(env, input, { ...cfg, j3: { ...cfg.j3, quiet: { ...cfg.j3.quiet, instructions: 'edited' } } });
    expect(sent(f).questions.quiet.instructions).toBe('edited');
  });
  it('a one-format run sends the other part as null', () => {
    const out = j3Input(row('fx-email'), fxPlan('fx-email'), fxCatalog());
    expect(out.email).toEqual(expect.any(String));
    expect(out.landing_page).toBeNull();
  });
});

describe('named 4: new_user input carries no summary', () => {
  it('exactly the J3Input keys, and no field about the person but the occasion', async () => {
    const out = j3Input(row('fx-newuser'), fxPlan('fx-newuser'), fxCatalog());
    expect(Object.keys(out).sort()).toEqual(['email', 'landing_page', 'new_user', 'occasion', 'occasion_key', 'picks', 'quote']);
    expect(out.new_user).toBe(true);
    const f = stubFetch(() => reply());
    await judgeDraft(env, out, cfg);
    expect(Object.keys(sent(f).state).sort()).toEqual(Object.keys(out).sort());
    expect(JSON.stringify(sent(f).state)).not.toMatch(/summary|first_name|display_name|Fixture|fx-newuser/);
  });
});

describe('j3Input', () => {
  const cat = fxCatalog();
  it('reads prose, never the rendered HTML', () => {
    expect(JSON.stringify(j3Input(row('fx-both'), fxPlan('fx-both'), cat))).not.toContain('<p>rendered</p>');
  });
  it('picks are title and facet words, no id, handle or price', () => {
    const plan = fxPlan('fx-both');
    const out = j3Input(row('fx-both'), plan, cat);
    const p = cat.rows.get(plan.picks[0].product_id)!;
    expect(out.picks).toHaveLength(plan.picks.length);
    expect(Object.keys(out.picks[0]).sort()).toEqual(['facets', 'title']);
    expect(out.picks[0].title).toBe(p.title);
    expect(out.picks[0].facets).toEqual(expect.arrayContaining(p.class));
    expect(new Set(out.picks[0].facets).size).toBe(out.picks[0].facets.length);
    const s = JSON.stringify(out.picks);
    expect(s).not.toContain(p.handle);
    expect(s).not.toContain(p.id);
    expect(s).not.toContain(p.variants[0].price);
  });
  it('a quote section is site copy: in `quote`, out of the model\'s words', () => {
    const line = 'Light the diya, set a flower down, and begin.';
    const m: ModelJson = { landing_page: { occasion_key: null, sections: [{ type: 'quote', quote_id: 'E4' }, { type: 'story', text: `Around it. ${line}` }] } };
    const out = j3Input(row('fx-both', m), fxPlan('fx-both'), cat);
    expect(out.quote).toBe(line);
    expect(out.landing_page).not.toContain(line);
    expect(out.email).toBeNull();
    expect(j3Input(row('fx-both', { landing_page: { sections: [] } }), fxPlan('fx-both'), cat).quote).toBeNull();
  });
  it('an unparsed draft has no parts', () => {
    expect(j3Input(row('fx-both', { unparsed: 'x' }), fxPlan('fx-both'), cat)).toMatchObject({ email: null, landing_page: null, quote: null });
  });
});

describe('flaggedQuestions, the only reading of a gate', () => {
  it('all good flags nothing', () => {
    expect(flaggedQuestions(goodAnswers(), cfg)).toEqual([]);
    expect(isFlagged(goodAnswers(), cfg)).toBe(false);
  });
  it('all bad flags every question, in config order', () => {
    expect(flaggedQuestions(badAnswers(), cfg)).toEqual(Object.keys(cfg.j3));
    expect(isFlagged(badAnswers(), cfg)).toBe(true);
  });
  it.each([[0.49, false], [0.5, true], [0.51, true]])('`bad: true` Noul at %d', (n, want) => {
    expect(flaggedQuestions(goodAnswers({ discount: noul(n) }), cfg).includes('discount')).toBe(want);
  });
  it.each([[0.51, false], [0.5, true], [0.49, true]])('`bad: false` Noul (scene) at %d', (n, want) => {
    expect(flaggedQuestions(goodAnswers({ scene: noul(n) }), cfg).includes('scene')).toBe(want);
  });
  it('the gate is the config\'s, so an old run keeps its old flags', () => {
    const a = goodAnswers({ discount: noul(0.6) });
    expect(flaggedQuestions(a, cfg)).toEqual(['discount']);
    expect(flaggedQuestions(a, { ...cfg, flag_gate: 0.7 })).toEqual([]);
  });
  it.each([[0.59, false], [0.6, true]])('Score on the lowest level at confidence %d', (c, want) => {
    expect(flaggedQuestions(goodAnswers({ quiet: score(0.9, c) }), cfg).includes('quiet')).toBe(want);
  });
  it('a Score likeliest above the lowest level is not flagged, however confident', () => {
    expect(flaggedQuestions(goodAnswers({ quiet: score(0.2, 0.9) }), cfg)).toEqual([]);
  });
  it('a missing or malformed answer flags nothing', () => {
    expect(flaggedQuestions({}, cfg)).toEqual([]);
    expect(flaggedQuestions({ discount: null, scene: {}, quiet: { confidence: 0.9 }, specific: { probabilities: {}, confidence: 0.9 } }, cfg)).toEqual([]);
  });
});

describe('jevPreflight', () => {
  it('passes on a 200 that names the pinned model', async () => {
    const f = stubFetch(() => reply({ data: [{ id: cfg.model }] }));
    expect(await jevPreflight(env, cfg)).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/models');
  });
  it('fails, never throws', async () => {
    stubFetch(() => reply({ data: [] }));
    expect(await jevPreflight(env, cfg)).toEqual({ ok: false, reason: 'model_not_listed' });
    stubFetch(() => reply({}, 401));
    expect(await jevPreflight(env, cfg)).toEqual({ ok: false, reason: 'http_401' });
    stubFetch(() => { throw new TypeError('x'); });
    expect(await jevPreflight(env, cfg)).toEqual({ ok: false, reason: 'network' });
    const f = stubFetch(() => reply());
    expect(await jevPreflight({} as AppEnv, cfg)).toEqual({ ok: false, reason: 'no_key' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('jevReserveOk, cumulative over every run (R111)', () => {
  // Real SQL against the real table: node:sqlite behind the one D1 call the function makes.
  const db = (charged: (number | null)[]) => {
    const sql = new DatabaseSync(':memory:');
    sql.exec(readFileSync('migrations/0001_core.sql', 'utf8'));
    charged.forEach((usd, i) => sql.prepare(`INSERT INTO jev_events (run_id, customer_id, attempt, model_requested, status, reason, charged_usd, basis_usd, at)
      VALUES (?, 'c', 1, 'm', 'unavailable', 'x', ?, 0.01, 't')`).run(`r${i}`, usd));
    return { prepare: (q: string) => ({ first: async () => sql.prepare(q).get() }) } as unknown as D1Database;
  };
  it('an empty ledger admits', async () => { expect(await jevReserveOk(db([]), 0.01)).toBe(true); });
  it('exactly at $0.25 admits', async () => { expect(await jevReserveOk(db([0.2]), 0.05)).toBe(true); });
  it('just over $0.25 refuses', async () => { expect(await jevReserveOk(db([0.2]), 0.0500001)).toBe(false); });
  it('sums across runs', async () => { expect(await jevReserveOk(db([0.1, 0.1, 0.05]), 0.01)).toBe(false); });
  it('a row with no request adds nothing', async () => { expect(await jevReserveOk(db([null, 0.2]), 0.05)).toBe(true); });
});
