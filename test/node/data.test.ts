import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import shapesJson from '../../config/shapes.json' with { type: 'json' };
import { buildSnapshot, readSamples } from '../../scripts/build.ts';
import { toCatalog } from '../../src/lib/catalog/index.ts';
import { stripBody } from '../../src/lib/catalog/strip.ts';
import { BadCustomerFile, ingestTsv } from '../../src/lib/ingest.ts';
import { countKeys, planCustomer } from '../../src/lib/plan.ts';
import { parseRecs, parseRowKeys } from '../../src/lib/recs.ts';
import { computeShape } from '../../src/lib/shape.ts';
import type { Catalog, IngestResult, Pinned, RecRow, RowKeys, ShapesFile } from '../../src/contracts/types.ts';
import { fxCatalog, fxPinned } from '../fakes/index.ts';

const shapes = shapesJson as ShapesFile;
const HEADER = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\n';
const REAL = readFileSync('data/customers.with-c20.synthetic.tsv', 'utf8');
const row = (key: string, occasion: string | null = 'Goa weekend', new_user = false): IngestResult =>
  ({ key, status: 'ok', record: { customer_id: key, first_name: 'Asha', occasion, new_user } });
const ids = (c: Catalog, n: number) => c.usable.slice(0, n).map((p) => p.id);
const rec = (customer_id: string, pids: string[], reason_code: RecRow['picks'][0]['reason_code'] = 'OCCASION_MATCH'): RecRow =>
  ({ customer_id, picks: pids.map((product_id) => ({ product_id, reason_code })) });
const code = (p: { outcome: { kind: string; code?: string } }) => p.outcome.code ?? p.outcome.kind;
const fx = fxCatalog();
const plan = (item: IngestResult, r: RecRow | null, keys: RowKeys = {}, pinned: Pinned = fxPinned) => planCustomer(item, r, keys, fx, pinned, shapes);

describe('test 1: snapshot from samples/site', () => {
  let s: ReturnType<typeof buildSnapshot>;
  beforeAll(() => { s = buildSnapshot(readSamples()); }, 120_000);
  it('rebuilds the snapshot the recommendations pin', () => {
    expect(s.catalog.snapshot_id).toBe(JSON.parse(readFileSync('data/recommendations.synthetic.json', 'utf8')).snapshot_id);
  });
  it('2,165 usable, stage by stage (LLD usable filter, right-hand column)', () => {
    expect(s.report.stages).toEqual({ after_hidden_and_bundle: 2275, after_season: 2206, after_class: 2190, usable: 2165 });
    expect(s.catalog.rows.filter((p) => p.excluded_reason === null)).toHaveLength(2165);
  });
  it('keeps every non-gift-card row, 8,940, and 2,180 of them usable after toCatalog', () => {
    expect(s.catalog.rows).toHaveLength(8940);
    expect(s.report.excluded.GIFT_CARD).toBe(7131);
    const c = toCatalog(s.catalog, s.rules);
    expect(c.usable).toHaveLength(2165);
    expect(c.rows.size).toBe(8940);
  });
  it('rules: 157 noun stems, cores and handles', () => {
    expect(s.rules.nouns).toHaveLength(157);
    expect(s.rules.handles).toHaveLength(8940);
    expect(s.rules.title_cores.length).toBeGreaterThan(6300);   // probe 10: 6,325, keyed on token tuples
    expect(s.rules.distinctive_cores).toHaveLength(3794);       // probe 10, t=2
    expect(s.rules.nouns).toContain('dres');   // the (es|s)$ stem
    expect(s.rules.nouns).not.toContain('linen');
  });
  it('agrees with the fixture on real rows (its usability, bodies, collection and campaign came from a throwaway mapper, so not those)', () => {
    const c = toCatalog(s.catalog, s.rules);
    for (const f of fx.usable) {
      const p = c.rows.get(f.id)!;
      for (const k of ['handle', 'title', 'url', 'category', 'subcategory', 'class'] as const)   // images and variants drift: the fixture is from the earlier pull
        expect(p[k], `${f.handle}.${k}`).toEqual(f[k]);
    }
  });
  it('drops gift cards, sale tags and raw html from the projection', () => {
    const json = JSON.stringify(s.catalog.rows[0]);
    expect(json).not.toContain('body_html');
    expect(json).not.toContain('raw_tags');
    expect(s.catalog.rows.some((p) => p.excluded_reason === 'OUT_OF_SEASON' && p.subcategory.includes('Rakhi'))).toBe(true);
    expect(s.catalog.rows.every((p) => p.available || p.body_text_clean === null)).toBe(true);
  });
  it('every rec pick is usable in the real snapshot', () => {
    const c = toCatalog(s.catalog, s.rules);
    const recs = parseRecs(JSON.parse(readFileSync('data/recommendations.synthetic.json', 'utf8')));
    for (const r of recs.rows) for (const k of r.picks) expect(c.rows.get(k.product_id)?.excluded_reason, k.product_id).toBeNull();
  });
  it('test 5: shapes on the 19, 0 open; c20 open; every plan ready; signals', () => {
    const c = toCatalog(s.catalog, s.rules);
    const recs = parseRecs(JSON.parse(readFileSync('data/recommendations.synthetic.json', 'utf8')));
    const keys = parseRowKeys(JSON.parse(readFileSync('data/row_keys.synthetic.json', 'utf8')));
    const plans = ingestTsv(REAL).map((i) => planCustomer(i, recs.rows.find((r) => r.customer_id === i.key) ?? null, keys, c, fxPinned, shapes));
    expect(plans.map(code)).toEqual(Array(20).fill('ready'));
    const shape = Object.fromEntries(plans.map((p) => [p.customer_id, p.shape]));
    expect(shape).toEqual({ c01: 'wedding', c02: 'trip', c03: 'scene', c04: 'gift', c05: 'home', c06: 'trip', c07: 'home', c08: 'scene', c09: 'wedding', c10: 'trip',
      c11: 'wedding', c12: 'scene', c13: 'scene', c14: 'gift', c15: 'trip', c16: 'gift', c17: 'scene', c18: 'trip', c19: 'wedding', c20: 'open' });
    const c20 = plans.at(-1)!;
    expect(c20).toMatchObject({ new_user: true, display_name: null, occasion: null, occasion_key: null, signals: ['season_prior'] });
    expect(plans.every((p) => p.picks.every((k) => ['wear', 'home'].includes(k.group)))).toBe(true);
    expect(c.rows.get(plans[0].picks[0].product_id)).toBeTruthy();
    expect(plans.slice(0, 19).every((p) => p.signals.length === 0)).toBe(true);
    const out = JSON.stringify(plans);   // test 6 on the real file
    for (const l of REAL.split('\n').slice(1, 20)) {
      const [, first, last, , note] = l.split('\t');
      if (last && last !== first) expect(out).not.toContain(`"${last}"`);   // c16 is Aditi Aditi
      expect(out).not.toContain(note);
    }
  });
});

describe('test 2: 19 rows and the traps', () => {
  const r = ingestTsv(readFileSync('data/customers.nicobar.tsv', 'utf8'));
  const c = (i: number) => (r[i] as Extract<IngestResult, { status: 'ok' }>).record;
  it('19 ok rows, keys are ids', () => {
    expect(r).toHaveLength(19);
    expect(r.every((x) => x.status === 'ok')).toBe(true);
    expect(r[18].key).toBe('c19');
  });
  it('blank last name is valid; lower-case first names stay raw on Customer', () => {
    expect(c(4)).toMatchObject({ customer_id: 'c05', first_name: 'Riya', occasion: 'Housewarming', new_user: false });
    expect(c(7).first_name).toBe('ishaan');
  });
  it('display name: upper only a wholly lower token, keep S and Leela, blank is null', () => {
    const name = (first_name: string | null) => plan({ key: 'x', status: 'ok', record: { customer_id: 'x', first_name, occasion: 'Goa', new_user: false } }, null).display_name;
    expect(name('ishaan')).toBe('Ishaan');
    expect(name('S')).toBe('S');
    expect(name('Leela')).toBe('Leela');
    expect(name('mary Anne')).toBe('Mary Anne');
    expect(name(null)).toBeNull();
  });
  it('c20 is new_user, four blanks, no failure at ingest', () => {
    expect(ingestTsv(REAL)[19]).toEqual({ key: 'c20', status: 'ok', record: { customer_id: 'c20', first_name: null, occasion: null, new_user: true } });
  });
  for (const note of ['', ' - ', 'n/a', 'NONE', 'null', 'no purchase history', 'No orders yet'])
    it(`new_user on note ${JSON.stringify(note)}`, () => {
      const [x] = ingestTsv(`${HEADER}a\tB\tC\tGoa\t${note}\n`);
      expect(x).toMatchObject({ status: 'ok', record: { new_user: true, occasion: 'Goa' } });
    });
  it('a note with text is not new_user', () => {
    expect(ingestTsv(`${HEADER}a\tB\tC\tGoa\tBought the shirt.\n`)[0]).toMatchObject({ record: { new_user: false } });
  });
});

describe('test 3: row and file failures', () => {
  it('3-field row is row:<n> alone, 1-based over data rows; others stand', () => {
    const r = ingestTsv(`${HEADER}a\tB\tC\tGoa\tBought it.\nb\tC\tD\nc\tD\tE\tGoa\tBought it.\n`);
    expect(r.map((x) => [x.key, x.status])).toEqual([['a', 'ok'], ['row:2', 'invalid'], ['c', 'ok']]);
  });
  it('bad id is row:<n>', () => expect(ingestTsv(`${HEADER}a b\tB\tC\tGoa\tx\n`)[0]).toMatchObject({ key: 'row:1', status: 'invalid' }));
  it('every occurrence of a repeated id is row:<n>, duplicate', () => {
    const r = ingestTsv(`${HEADER}a\tB\tC\tGoa\tx\nb\tB\tC\tGoa\tx\na\tB\tC\tGoa\tx\n`);
    expect(r.map((x) => [x.key, x.status])).toEqual([['row:1', 'duplicate'], ['b', 'ok'], ['row:3', 'duplicate']]);
  });
  it('blank occasion and not new_user is invalid, keyed by id', () => {
    expect(ingestTsv(`${HEADER}a\tB\tC\t \tBought it.\n`)[0]).toMatchObject({ key: 'a', status: 'invalid' });
  });
  it('bad header, 0 rows, CRLF: BadCustomerFile, which the route answers 400', () => {
    expect(() => ingestTsv('id\tname\nc1\tA\n')).toThrow(BadCustomerFile);
    expect(() => ingestTsv(HEADER)).toThrow(BadCustomerFile);
    expect(() => ingestTsv(HEADER.replace('\n', '\r\n'))).toThrow(BadCustomerFile);
    try { ingestTsv(''); } catch (e) { expect((e as BadCustomerFile).code).toBe('BAD_INPUT'); }
  });
});

describe('test 4: prep order, first hit wins', () => {
  it('invalid and duplicate rows fail with their code and null fields', () => {
    expect(plan({ key: 'row:3', status: 'invalid', errors: ['x'] }, null)).toMatchObject({ customer_id: 'row:3', shape: null, picks: [], outcome: { kind: 'failed', code: 'INVALID_CUSTOMER' } });
    expect(code(plan({ key: 'row:4', status: 'duplicate', errors: ['x'] }, rec('row:4', ids(fx, 4))))).toBe('DUPLICATE_CUSTOMER_ID');
  });
  it('no rec row: new_user cold start, else no recommendation', () => {
    expect(code(plan(row('a', null, true), null))).toBe('COLD_START_NO_HISTORY');
    expect(code(plan(row('a'), null))).toBe('NO_RECOMMENDATION');
  });
  it('unusable, unknown or repeated pick is INVALID_PICK, before TOO_FEW', () => {
    expect(code(plan(row('a'), rec('a', ['nope'])))).toBe('INVALID_PICK');
    const [p] = ids(fx, 1);
    expect(code(plan(row('a'), rec('a', [p, p, ...ids(fx, 4).slice(1)])))).toBe('INVALID_PICK');
    const excluded = { ...fx.rows.get(p)!, excluded_reason: 'THIN_COPY' };
    const cat = { ...fx, rows: new Map(fx.rows).set(p, excluded) };
    expect(code(planCustomer(row('a'), rec('a', ids(fx, 4)), {}, cat, fxPinned, shapes))).toBe('INVALID_PICK');
  });
  it('TOO_FEW: under 4 for both and landing_page, under 3 for email; a rec row of 0', () => {
    expect(code(plan(row('a'), rec('a', ids(fx, 3))))).toBe('TOO_FEW_CANDIDATES');
    expect(code(plan(row('a'), rec('a', ids(fx, 3)), {}, { ...fxPinned, format: 'landing_page' }))).toBe('TOO_FEW_CANDIDATES');
    expect(code(plan(row('a'), rec('a', ids(fx, 3)), {}, { ...fxPinned, format: 'email' }))).toBe('ready');
    expect(code(plan(row('a'), rec('a', ids(fx, 2)), {}, { ...fxPinned, format: 'email' }))).toBe('TOO_FEW_CANDIDATES');
    expect(code(plan(row('a', null, true), rec('a', [])))).toBe('TOO_FEW_CANDIDATES');
  });
  it('ready plan: ranked slots, group from House & Home, pinned format, no admission', () => {
    const p = plan(row('a'), rec('a', ids(fx, 4)));
    expect(p.picks.map((k) => k.slot)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(p.picks[0].group).toBe('home');
    expect(p).toMatchObject({ format: 'both', admission: null, pinned: fxPinned });
    const wear = fx.usable.find((x) => !x.category.includes('House & Home'))!;
    expect(plan(row('a'), rec('a', [wear.id, ...ids(fx, 3)])).picks[0].group).toBe('wear');
  });
});

describe('test 5: computeShape', () => {
  it('null and no match are open; first match wins; trip is case-sensitive', () => {
    expect(computeShape(null, shapes)).toBe('open');
    expect(computeShape('Tuesday', shapes)).toBe('open');
    expect(computeShape('Wedding guest in Udaipur', shapes)).toBe('wedding');
    expect(computeShape('in paris', shapes)).toBe('open');
    expect(computeShape('in Paris', shapes)).toBe('trip');
  });
});

describe('test 5a: row keys', () => {
  it('a row key reaches Plan; unknown id and null are null, draft continues, counted', () => {
    const keys = parseRowKeys({ a: { key: 'wedding' }, b: { key: null } });
    const go = (id: string) => plan(row(id), rec(id, ids(fx, 4)), keys);
    expect(go('a').occasion_key).toBe('wedding');
    expect(go('b')).toMatchObject({ occasion_key: null, outcome: { kind: 'ready' } });
    expect(go('zz')).toMatchObject({ occasion_key: null, outcome: { kind: 'ready' } });
    expect(countKeys(['a', 'b', 'zz'], keys)).toEqual({ null_key: 1, unknown_id: 1 });
  });
  for (const [name, bad] of [['_label', { a: { key: 'x', _label: 'y' } }], ['g_name', { a: { key: 'x', g_name: 'she' } }], ['fit', { a: { key: null, fit: 'exact' } }],
    ['no key', { a: {} }], ['a non-object value', { a: 'wedding' }], ['null value', { a: null }], ['numeric key', { a: { key: 1 } }], ['an array', []]] as const)
    it(`refuses ${name}`, () => expect(() => parseRowKeys(bad)).toThrow());
  it('passes the repo table', () => expect(Object.keys(parseRowKeys(JSON.parse(readFileSync('data/row_keys.synthetic.json', 'utf8'))))).toHaveLength(20));
});

describe('parseRecs', () => {
  const good = { version: 'recommendations/v1', synthetic: true, as_of: '2026-10-29', snapshot_id: 's', rule: 'r', rows: [{ customer_id: 'a', picks: [{ product_id: '1', reason_code: 'HAND_SET' }] }] };
  it('reads a good file and the repo file', () => {
    expect(parseRecs(good).rows[0].picks[0].product_id).toBe('1');
    expect(parseRecs(JSON.parse(readFileSync('data/recommendations.synthetic.json', 'utf8'))).rows).toHaveLength(20);
  });
  const pick = { product_id: '1', reason_code: 'HAND_SET' };
  for (const [name, bad] of [['wrong version', { ...good, version: 'x' }], ['no rows', { ...good, rows: undefined }], ['null', null],
    ['7 picks', { ...good, rows: [{ customer_id: 'a', picks: Array(7).fill(pick) }] }],
    ['unknown reason', { ...good, rows: [{ customer_id: 'a', picks: [{ product_id: '1', reason_code: 'X' }] }] }],
    ['a title in a pick', { ...good, rows: [{ customer_id: 'a', picks: [{ ...pick, title: 'x' }] }] }],
    ['a numeric id', { ...good, rows: [{ customer_id: 'a', picks: [{ product_id: 1, reason_code: 'HAND_SET' }] }] }],
    ['a repeated customer', { ...good, rows: [good.rows[0], good.rows[0]] }]] as const)
    it(`refuses ${name}`, () => expect(() => parseRecs(bad)).toThrow());
});

describe('test 5b: signals', () => {
  it('set only when new_user', () => {
    expect(plan(row('a'), rec('a', ids(fx, 4), 'NEW_USER_PRIOR')).signals).toEqual([]);
    expect(plan(row('a', 'Goa', true), rec('a', ids(fx, 4))).signals).toEqual(['occasion']);
    expect(plan(row('a', null, true), rec('a', ids(fx, 4), 'NEW_USER_PRIOR')).signals).toEqual(['season_prior']);
    expect(plan(row('a', 'Goa', true), rec('a', ids(fx, 4), 'NEW_USER_PRIOR')).signals).toEqual(['occasion', 'season_prior']);
    expect(plan(row('a', null, true), rec('a', ids(fx, 4))).signals).toEqual([]);
  });
});

describe('test 6: last_name stops at ingest; the note stops as words, and never reaches a plan (R123)', () => {
  it('absent from every output, good rows and bad', () => {
    const r = ingestTsv(`${HEADER}a\tAsha\tSECRETLAST\tGoa\tBought the SECRETNOTE.\nb\tRia\tSECRETLAST\nc\tSECRETLAST\tSECRETNOTE\na b\tx\ty\n`);
    const plans = r.map((i) => plan(i, null));
    expect(JSON.stringify(r)).not.toContain('SECRETLAST');
    expect(JSON.stringify(r)).not.toContain('Bought the');
    const out = JSON.stringify(plans).toLowerCase();
    expect(out).not.toContain('secretlast');
    expect(out).not.toContain('secretnote');
  });
});

describe('strip', () => {
  it('follows strip.json: blocks, entities, dimensions, discount, count', () => {
    expect(stripBody('<p>A fine &amp; quiet shawl.</p><p>Dimensions: 10 cm</p><li>On sale today.</li>', 'Shawl')).toBe('A fine & quiet shawl.');
    expect(stripBody('<p>Comes as a set of 3 plates. Soft.</p>', 'Bowl - Set of 4')).toBe('Soft.');
    expect(stripBody('<p>A set of 4 plates. Soft.</p>', 'Bowl - Set of 4')).toBe('A set of 4 plates. Soft.');
    expect(stripBody('<p>Pretty\u0092s glow.</p>', 'x')).toBe('Pretty’s glow.');
  });
});

describe('test 5c: build --publish makes 0 network requests', () => {
  const hook = resolve('test/node/block-network.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'build-'));
  const log = join(dir, 'net.log');
  const env = { ...process.env, NET_LOG: log, NODE_OPTIONS: `--import=${hook}` };
  it('the hook does catch a leaving request (RFC 5737 address, nothing is sent)', () => {
    const l = join(dir, 'probe.log');
    spawnSync(process.execPath, ['-e', `fetch('http://203.0.113.1/').catch(()=>{}); require('net').connect(80,'203.0.113.2').on('error',()=>{})`], { env: { ...env, NET_LOG: l } });
    expect(readFileSync(l, 'utf8')).toContain('203.0.113.');
  });
  it('writes the local row and local R2 files, with nothing leaving loopback', () => {
    const persist = join(dir, 'state');
    const r = spawnSync(process.execPath, ['scripts/build.ts', '--publish', '--persist-to', persist], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
    const id = /snapshot (\S+):/.exec(r.stdout)![1];
    const q = execFileSync('npx', ['wrangler', 'd1', 'execute', 'nicobar', '--local', '--persist-to', persist, '--json', '--command', 'SELECT * FROM snapshots'],
      { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    expect(JSON.parse(q)[0].results).toEqual([{ id, fetched_at: '2026-11-01T09:43:13.000Z', product_rows: 8940, usable_rows: 2165, synthetic: 0 }]);
    const back = join(dir, 'c.json');
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `nicobar/snapshots/${id}/rules.json`, '--local', '--persist-to', persist, '--file', back],
      { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    expect(JSON.parse(readFileSync(back, 'utf8')).nouns).toHaveLength(157);
  }, 180_000);
});
