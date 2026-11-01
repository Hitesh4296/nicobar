// P0 and P1 rules, overrides on a catalog, and what they do to the ranking. Pure: no store.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snapshotCatalog } from '../../scripts/eval.ts';
import { toCatalog } from '../../src/lib/catalog/index.ts';
import ranking from '../../config/ranking.json' with { type: 'json' };
import shapes from '../../config/shapes.json' with { type: 'json' };
import rules from '../../config/usable_rules.json' with { type: 'json' };
import type { Catalog, Product } from '../../src/contracts/types.ts';
import { EMPTY, RULES, applyCatalog, rankConfigFor, reasonsOf, sets, statusOf } from '../../src/lib/catalog/override.ts';
import { validateCatalog } from '../../src/lib/config/index.ts';
import { planCustomer } from '../../src/lib/plan.ts';
import { rankAll, rankConfig, rankCustomer, readCustomers, type RankConfig } from '../../src/lib/rank/index.ts';
import { validateRendered } from '../../src/lib/check/index.ts';

const IMG = { src: 'https://cdn.shopify.com/a.jpg', src_canonical: 'https://cdn.shopify.com/a.jpg', position: 1, variant_ids: [] };
const product = (id: string, over: Partial<Product>): Product => ({ id, handle: `h-${id}`, title: `T ${id}`, url: '', body_text_clean: 'Body.', category: ['Accessories'], subcategory: [`S${id}`], class: [`K${id}`], subclass: [],
  wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [], room_or_use: [], collection: [], campaign: [], occasion_keys: [], prior_tags: [], material: null, material_group: null, colours: [], gender: null,
  design_group: null, badges: [], is_bestseller_gift: false, available: true, variants: [], images: [IMG], excluded_reason: null, excluded_reasons: [], content_sha256: '', ...over });
const fail = (...r: string[]) => ({ excluded_reason: r[0], excluded_reasons: r });
const cat = (rows: Product[]): Catalog => ({ snapshot_id: 's', fetched_at: 't', rows: new Map(rows.map((p) => [p.id, p])), by_sku: new Map(), usable: rows.filter((p) => p.excluded_reason === null), rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: [] } });
const O = (o: Partial<typeof EMPTY>) => ({ ...EMPTY, ...o });
const ids = (c: Pick<Catalog, 'usable'>) => c.usable.map((p) => p.id);

describe('the rule list', () => {
  it('names every rule with a plain name, a why and a priority', () => {
    for (const r of rules.rules) { expect(r.name.length).toBeGreaterThan(3); expect(r.why.length).toBeGreaterThan(10); expect(['P0', 'P1']).toContain(r.priority); }
  });
  it('P0 is the five the owner named, and P1 the rest', () => {
    const p0 = RULES.filter((r) => r.priority === 'P0').map((r) => r.id);
    for (const id of ['NOT_AVAILABLE', 'NO_IMAGE', 'NO_BODY', 'HIDDEN', 'GIFT_CARD']) expect(p0).toContain(id);
    for (const id of ['BUNDLE', 'OUT_OF_SEASON', 'THIN_COPY', 'NO_CLASS', 'NO_CATEGORY', 'BAR_ALPHABET', 'BAR_GIFT_SETS', 'BAR_PETS']) expect(RULES.find((r) => r.id === id)?.priority).toBe('P1');
  });
  it('every P1 rule says how an overridden product behaves', () => { for (const r of RULES) if (r.priority === 'P1') expect(r.if_enabled).toBeTruthy(); });
  it('the three bars cover ranking.json exactly', () => {
    const bars = RULES.flatMap((r) => (r.bar ? [r.bar] : []));
    expect(bars.flatMap((b) => b.class ?? []).sort()).toEqual([...ranking.barred.class].sort());
    expect(bars.flatMap((b) => b.subcategory ?? []).sort()).toEqual([...ranking.barred.subcategory].sort());
    expect(bars.flatMap((b) => b.handle_words ?? []).sort()).toEqual([...ranking.barred.handle_words].sort());
  });
});

describe('P0 cannot be overridden', () => {
  const rows = [product('sold', { ...fail('NOT_AVAILABLE'), available: false }), product('hid', fail('BUNDLE', 'HIDDEN')), product('old', { excluded_reason: 'BUNDLE', excluded_reasons: undefined }), product('noimg', { images: [] })];
  it('an enabled P0 product stays out, whatever the version says', () => {
    const c = applyCatalog(cat(rows), O({ enabled: rows.map((p) => p.id), rules_off: ['BUNDLE'] }));
    expect(ids(c)).toEqual([]);
    for (const p of rows) expect(c.rows.get(p.id)!.excluded_reason).not.toBeNull();
  });
  it('the fields are read again: a row whose reasons were lost still fails', () => {
    expect(reasonsOf(product('x', { available: false }))).toContain('NOT_AVAILABLE');
    expect(reasonsOf(product('x', { body_text_clean: null }))).toContain('NO_BODY');
    expect(statusOf(rows[3], sets(O({ enabled: ['noimg'] })))).toBe('p0');
  });
  it('an old snapshot, with one recorded reason, is not overridable', () => {
    expect(statusOf(rows[2], sets(O({ enabled: ['old'], rules_off: ['BUNDLE'] })))).toBe('p0');
  });
  it('a version may not switch a P0 rule off, list one id twice, or carry junk', () => {
    expect(validateCatalog(O({ rules_off: ['NOT_AVAILABLE'] })).ok).toBe(false);
    expect(validateCatalog(O({ rules_off: ['MADE_UP'] })).ok).toBe(false);
    expect(validateCatalog(O({ enabled: ['1'], disabled: ['1'] })).ok).toBe(false);
    expect(validateCatalog({ rules_off: [], enabled: [1], disabled: [] } as never).ok).toBe(false);
    expect(validateCatalog(O({ rules_off: ['BUNDLE'], enabled: ['1'] })).ok).toBe(true);
  });
});

describe('status', () => {
  const s = (p: Product, o = {}) => statusOf(p, sets(O(o)));
  it('reads off the five states', () => {
    expect(s(product('a', {}))).toBe('usable');
    expect(s(product('a', fail('BUNDLE')))).toBe('p1');
    expect(s(product('a', { ...fail('NOT_AVAILABLE'), available: false }))).toBe('p0');
    expect(s(product('a', fail('BUNDLE')), { enabled: ['a'] })).toBe('enabled');
    expect(s(product('a', fail('BUNDLE')), { rules_off: ['BUNDLE'] })).toBe('enabled');
    expect(s(product('a', {}), { disabled: ['a'] })).toBe('disabled');
  });
  it('a product with two P1 reasons needs both off, or an item enable', () => {
    const p = product('a', fail('BUNDLE', 'NO_CLASS'));
    expect(s(p, { rules_off: ['BUNDLE'] })).toBe('p1');
    expect(s(p, { rules_off: ['BUNDLE', 'NO_CLASS'] })).toBe('enabled');
    expect(s(p, { enabled: ['a'] })).toBe('enabled');
  });
  it('a ranking bar is a P1 reason on a usable row', () => {
    const p = product('a', { handle: 'alphabet-mug' });
    expect(reasonsOf(p)).toEqual(['BAR_ALPHABET']);
    expect(s(p)).toBe('p1');
    expect(s(p, { rules_off: ['BAR_ALPHABET'] })).toBe('enabled');
  });
  it('disabled wins over enabled by rule', () => { expect(s(product('a', fail('BUNDLE')), { rules_off: ['BUNDLE'], disabled: ['a'] })).toBe('disabled'); });
});

describe('applyCatalog', () => {
  const rows = [product('a', {}), product('b', fail('BUNDLE')), product('c', { handle: 'gift-set-x' })];
  it('never touches the catalog it was given', () => {
    const base = cat(rows), before = ids(base);
    applyCatalog(base, O({ enabled: ['b'], disabled: ['a'] }));
    expect(ids(base)).toEqual(before);
    expect(base.rows.get('b')!.excluded_reason).toBe('BUNDLE');
    expect(base.rows.get('a')!.excluded_reason).toBeNull();
  });
  it('gives each changed row the state the plan reads', () => {
    const c = applyCatalog(cat(rows), O({ enabled: ['b'], disabled: ['a'] }));
    expect(ids(c)).toEqual(['b']);
    expect(c.rows.get('b')!.excluded_reason).toBeNull();
    expect(c.rows.get('a')!.excluded_reason).toBe('DISABLED');
    expect(c.rows.get('c')!.excluded_reason).toBe('BAR_GIFT_SETS');
  });
});

const CFG: RankConfig = { version: 'rank-v1', weights: { occasion: 100, season: 20, bestseller: 15, new: 10, past: 10 }, limits: { family_cap: 2, family_cap_max: 6, rail: 8, occasion_rail: 24, category_rails: 3, category_min: 3 },
  barred: ranking.barred, gift_keys: [], fresh_badge: 'New', pools: {}, plurals: {}, complements: {}, new_user_picks: [], rows: { c1: { type: 'wear', picks: 4, key: 'wedding' }, c2: { type: 'wear', picks: 2, key: 'wedding', hand: ['h-1', 'h-2'] }, c3: { type: 'new_user', picks: 2, key: null } } };
const C1 = { customer_id: 'c1', occasion: 'Wedding', note: null };
const occ = (id: string, over: Partial<Product> = {}) => product(id, { occasion_keys: ['wedding'], ...over });
const ranked = (rows: Product[], o: Partial<typeof EMPTY>, c = C1) => { const a = applyCatalog(cat(rows), O(o)); return rankCustomer(c, a, rankConfigFor(CFG, a)); };

describe('the ranking', () => {
  const rows = [occ('1'), occ('2'), occ('3'), occ('9', fail('BUNDLE')), occ('8', { handle: 'alphabet-x' })];
  it('enabling a P1 product lets it rank', () => {
    expect(ranked(rows, {}).picks.map((p) => p.product_id)).not.toContain('9');
    expect(ranked(rows, { enabled: ['9'] }).picks.map((p) => p.product_id)).toContain('9');
  });
  it('switching a bar off, or enabling a barred item, lets it rank', () => {
    expect(ranked(rows, {}).picks.map((p) => p.product_id)).not.toContain('8');
    expect(ranked(rows, { rules_off: ['BAR_ALPHABET'] }).picks.map((p) => p.product_id)).toContain('8');
    expect(ranked(rows, { enabled: ['8'] }).picks.map((p) => p.product_id)).toContain('8');
  });
  it('disabling removes a pick, and a section entry', () => {
    const before = ranked(rows, {}).picks.map((p) => p.product_id);
    const r = ranked(rows, { disabled: [before[0]] });
    expect(r.picks.map((p) => p.product_id)).not.toContain(before[0]);
    expect(JSON.stringify(r.more ?? [])).not.toContain(`"${before[0]}"`);
  });
  it('no override ranks exactly as the bars did', () => {
    const base = cat(rows);
    expect(ranked(rows, {})).toEqual(rankCustomer(C1, base, CFG));
  });
  it('a disabled pinned product leaves that customer short; it does not throw', () => {
    const r = ranked([occ('1'), occ('2')], { disabled: ['2'] }, { customer_id: 'c2', occasion: 'W', note: null });
    expect(r.picks.map((p) => p.product_id)).toEqual(['1']);
  });
  it('two products with no class can rank, and a rail never carries an empty label', () => {
    const none = (id: string) => occ(id, { class: [], ...fail('NO_CLASS') });
    const r = ranked([occ('1'), occ('2'), occ('3'), occ('4'), none('5'), none('6'), none('7'), none('10')], { rules_off: ['NO_CLASS'] });
    for (const s of r.more ?? []) if (s.kind === 'occasion_category') expect(s.label).toBeTruthy();
    expect(rankAll([C1], applyCatalog(cat([none('5')]), O({ rules_off: ['NO_CLASS'] })), CFG).length).toBe(1);
  });
});

describe('stale plans', () => {
  const rows = [occ('1'), occ('2'), occ('3'), occ('4'), occ('5', fail('BUNDLE'))];
  const item = { key: 'c1', status: 'ok', record: { customer_id: 'c1', first_name: 'A', occasion: 'W', new_user: false, note_words: [] } } as never;
  const pinned = { format: 'both', run_date: 'd' } as never;
  const rec = (ids: string[]) => ({ customer_id: 'c1', picks: ids.map((product_id) => ({ product_id, reason_code: 'OCCASION_MATCH' as const })) });
  const plan = (c: Catalog, ps: string[]) => planCustomer(item, rec(ps), {}, c, pinned, shapes as never);
  it('a plan refuses a disabled pick by name, and takes an enabled one', () => {
    expect(plan(applyCatalog(cat(rows), O({ disabled: ['1'] })), ['1', '2', '3', '4']).outcome).toEqual({ kind: 'failed', code: 'INVALID_PICK' });
    expect(plan(cat(rows), ['5', '2', '3', '4']).outcome).toEqual({ kind: 'failed', code: 'INVALID_PICK' });
    expect(plan(applyCatalog(cat(rows), O({ enabled: ['5'] })), ['5', '2', '3', '4']).outcome).toEqual({ kind: 'ready' });
  });
  it('X checks read only the rows: they pass an enabled pick and do not read usability', () => {
    const c = applyCatalog(cat(rows), O({ enabled: ['5'], disabled: ['1'] }));
    const p = { customer_id: 'c1', picks: [{ slot: 'p1', product_id: '5' }, { slot: 'p2', product_id: '1' }] } as never;
    const env = { picks: [{ slot: 'p1', product_id: '5' }, { slot: 'p2', product_id: '1' }] } as never;
    const html = `<img data-slot="p1" src="${IMG.src}" alt="T 5"><img data-slot="p2" src="${IMG.src}" alt="T 1">`;
    const x1 = validateRendered({ email: null, landing_page: null, catalog: html }, env, c, p).filter((r) => r.id === 'X1');
    expect(x1.every((r) => r.pass)).toBe(true);
  });
});

const SNAP = 'out/snapshot/2026-10-29-67819ca378f4';
describe.skipIf(!existsSync(`${SNAP}/catalog.json`))('the frozen snapshot', () => {
  it('no override ranks all 20 customers byte for byte as the bars do, off the real rows', () => {
    const c = snapshotCatalog()!, json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
    const full = toCatalog({ snapshot_id: c.snapshot_id, fetched_at: c.fetched_at, rows: json(`${SNAP}/catalog.json`).rows }, c.rules);
    const cfg = rankConfig(ranking, json('data/row_keys.synthetic.json'), json('data/hand_table.synthetic.json').rows), people = readCustomers(readFileSync('data/customers.with-c20.synthetic.tsv', 'utf8'));
    const a = applyCatalog(full, EMPTY);
    expect(full.usable.length - a.usable.length).toBe(157);
    expect(rankAll(people, a, rankConfigFor(cfg, a))).toEqual(rankAll(people, full, cfg));
  });
});
