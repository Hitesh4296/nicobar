// R127: occasion is lexically first. Past purchase breaks ties inside it and can never lift a product over it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ranking from '../../config/ranking.json' with { type: 'json' };
import type { Catalog, Product, RecRow } from '../../src/contracts/types.ts';
import { parseRecs } from '../../src/lib/recs.ts';
import { changeOf, checkWeights, rankAll, rankConfig, rankCustomer, rankingBy, readCustomers, scoreOf, signalsOf, type RankConfig, type RankCustomer } from '../../src/lib/rank/index.ts';
import { planEvidence } from '../../src/ui/evidence.ts';
import type { CustomerData } from '../../src/ui/timeline.ts';
import { heldoutCatalog, snapshotCatalog } from '../../scripts/eval.ts';

const text = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const hand = JSON.parse(text('data/hand_table.synthetic.json')).rows;
const keys = JSON.parse(text('data/row_keys.synthetic.json'));
const customers = readCustomers(text('data/customers.with-c20.synthetic.tsv'));
const real = snapshotCatalog();
const cfg = rankConfig(ranking, keys, hand);
/** A clean clone has no out/: the fixture cannot hold the pinned rows, so those pins go. */
const fixtureCfg: RankConfig = { ...cfg, new_user_picks: [], rows: Object.fromEntries(Object.entries(cfg.rows).map(([c, r]) => [c, { ...r, hand: undefined }])) };
const live = real ?? heldoutCatalog();
const liveCfg = real ? cfg : fixtureCfg;

let n = 0;
const product = (over: Partial<Product>): Product => ({ id: String(++n), handle: `p-${n}`, title: `P ${n}`, url: '', body_text_clean: '', category: ['Accessories'], subcategory: ['Sub'], class: ['Studs'], subclass: [],
  wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [], room_or_use: [], collection: [], campaign: [], occasion_keys: [], prior_tags: [], material: null, material_group: null, colours: [], gender: null,
  design_group: null, badges: [], is_bestseller_gift: false, available: true, variants: [], images: [], excluded_reason: null, content_sha256: '', ...over });
const catalog = (rows: Product[]) => ({ usable: rows, rows: new Map(rows.map((p) => [p.id, p])) }) as unknown as Catalog;
const shirt: RankCustomer = { customer_id: 'x', occasion: "Sister's wedding", note: 'Bought the indigo travel shirt last spring.' };
const x = { ...cfg, rows: { x: { type: 'wear' as const, picks: 2, key: 'wedding' } } };
const ids = (r: RecRow) => r.picks.map((p) => p.product_id);

describe('occasion over past purchase', () => {
  it('a past-only product is never p1', () => {
    const past = product({ class: ['Chains'], is_bestseller_gift: true, badges: ['New'] }), tagged = product({ class: ['Studs'], occasion_keys: ['wedding'] });
    const r = rankCustomer(shirt, catalog([past, tagged]), x);
    expect(r.picks[0].product_id).toBe(tagged.id);
    expect(r.picks[0].reason_code).toBe('OCCASION_MATCH');
  });
  it('a product matching both may be p1, over one matching occasion alone', () => {
    // Three of the plain kind, so the hash cannot be what puts the matching one first.
    const plain = ['Studs', 'Hoops', 'Danglers'].map((k) => product({ class: [k], occasion_keys: ['wedding'] }));
    const both = product({ class: ['Chains'], occasion_keys: ['wedding'] });
    expect(rankCustomer(shirt, catalog([...plain, both]), x).picks[0].product_id).toBe(both.id);
  });
  it('with no occasion match at all, p1 is still not past-only, and the fallback is named', () => {
    const past = product({ class: ['Scarves'] }), plain = product({ class: ['Pouches'] });
    const r = rankCustomer(shirt, catalog([past, plain]), x);
    expect(r.picks.map((p) => p.product_id)).toEqual([plain.id, past.id]);
    expect(r.picks.every((p) => p.reason_code === 'FALLBACK_NON_OCCASION')).toBe(true);
  });
  it('a row of only past-only products gets no p1 rather than a past-only one', () => {
    expect(rankCustomer(shirt, catalog([product({ class: ['Scarves'] })]), x).picks).toEqual([]);
  });
  it('a site signal orders tier 1 ahead of the hash, and Best_gift speaks only on a gift row', () => {
    const none = { ...shirt, note: null };
    const row = (type: 'gift'|'wear', key: string) => ({ ...cfg, rows: { x: { type, picks: 1, key } } });
    const classes = ['Studs', 'Hoops', 'Danglers', 'Bags'];
    for (const best of classes) {   // Each takes a turn as the bestseller, so the hash cannot be what puts it first.
      const ps = classes.map((k) => product({ class: [k], occasion_keys: ['birthday'], is_bestseller_gift: k === best }));
      expect(catalog(ps).rows.get(rankCustomer(none, catalog(ps), row('gift', 'birthday')).picks[0].product_id)!.class[0]).toBe(best);
      expect(signalsOf(none, ps[classes.indexOf(best)], row('wear', 'evening').rows.x, cfg)).not.toContain('bestseller');
    }
  });
  it('a past-only product never sits above a tier 1 product, at any position', () => {
    const past = ['Chains', 'Scarves'].map((k) => product({ class: [k] })), tagged = ['Studs', 'Hoops'].map((k) => product({ class: [k], occasion_keys: ['wedding'] }));
    const r = rankCustomer(shirt, catalog([...past, ...tagged]), { ...x, rows: { x: { ...x.rows.x, picks: 3 } } });
    expect(r.picks.map((p) => p.reason_code)).toEqual(['OCCASION_MATCH', 'OCCASION_MATCH', 'FALLBACK_NON_OCCASION']);
  });
  it('a gift note gives no past signal', () => {
    const scarf = { customer_id: 'x', occasion: null, note: 'Bought the block-print scarf as a gift.' };
    expect(signalsOf(scarf, product({ class: ['Hoops'] }), x.rows.x, x)).not.toContain('goes_with:scarf');
  });
  it('a hand row is resorted so a past-only p1 moves down', () => {
    const past = product({ handle: 'hand-past', class: ['Socks'] }), fit = product({ handle: 'hand-fit', class: ['Bags'] });
    const c = { ...cfg, rows: { x: { type: 'wear' as const, picks: 2, key: null, pool: 'trip', hand: ['hand-past', 'hand-fit'] } },
      pools: { trip: ['Bags'] } };
    const r = rankCustomer(shirt, catalog([past, fit]), c);
    expect(ids(r)).toEqual([fit.id, past.id]);
    expect(r.picks.every((p) => p.reason_code === 'HAND_SET')).toBe(true);
  });
  it('p1 is tier 1 wherever any product passes the row, on every row', () => {
    const usable = live.usable.filter((p) => p.available);
    for (const c of customers) {
      const row = rankCustomer(c, live, liveCfg), rule = liveCfg.rows[c.customer_id];
      if (c.customer_id === 'c20' || !row.picks.length) continue;
      const p1 = live.rows.get(row.picks[0].product_id)!;
      const tier1 = usable.filter((p) => signalsOf(c, p, rule, liveCfg).some((s) => s.startsWith('occasion_tag') || s === 'fitted_class'));
      const passing = tier1.filter((p) => rankPasses(c, p));
      if (passing.length) expect(tier1).toContain(p1);
      const tiers = row.picks.map((p) => tier1.some((t) => t.id === p.product_id));
      expect(tiers.lastIndexOf(true), c.customer_id).toBeLessThan(tiers.indexOf(false) < 0 ? Infinity : tiers.indexOf(false));
    }
  });
});
const rankPasses = (c: RankCustomer, p: Product) => rankCustomer(c, catalog([p]), { ...liveCfg, rows: { [c.customer_id]: { ...liveCfg.rows[c.customer_id], hand: undefined, picks: 1 } } }).picks.length > 0;

describe('the row', () => {
  it('holds one per class and at most two per family while the pool allows', () => {
    const a = product({ class: ['Studs'], category: ['Jewellery'], occasion_keys: ['wedding'] }), b = product({ class: ['Studs'], category: ['Jewellery'], occasion_keys: ['wedding'] });
    const d = product({ class: ['Hoops'], category: ['Jewellery'], occasion_keys: ['wedding'] }), e = product({ class: ['Chains'], category: ['Jewellery'], occasion_keys: ['wedding'] }), s = product({ class: ['Pouches'] });
    const r = rankCustomer({ ...shirt, note: null }, catalog([a, b, d, e, s]), { ...x, rows: { x: { ...x.rows.x, picks: 3 } } });
    const classes = ids(r).map((i) => catalog([a, b, d, e, s]).rows.get(i)!.class[0]);
    expect(new Set(classes).size).toBe(3);
    expect(classes).toContain('Pouches');
  });
  it('bars Alphabet, Gift Sets and pets', () => {
    const bad = [product({ handle: 'alphabet-glass-v', occasion_keys: ['wedding'] }), product({ class: ['Gift Sets'], occasion_keys: ['wedding'] }), product({ subcategory: ['Pet Accessories'], occasion_keys: ['wedding'] })];
    expect(rankCustomer(shirt, catalog(bad), x).picks).toEqual([]);
  });
  it('takes no both-tagged product into a single-gender row', () => {
    const both = product({ category: ['Men'], gender: 'female', occasion_keys: ['wedding'] }), ok = product({ category: ['Women'], gender: 'female', occasion_keys: ['wedding'] });
    const c = { ...x, rows: { x: { ...x.rows.x, note_gender: 'f' as const } } };
    expect(ids(rankCustomer(shirt, catalog([both, ok]), c))).toEqual([ok.id]);
  });
  it('a gift row with no recipient leans neither way', () => {
    const female = product({ class: ['Studs'], gender: 'female', occasion_keys: ['festive'] }), male = product({ class: ['Hoops'], gender: 'male', occasion_keys: ['festive'] });
    const men = product({ class: ['Bags'], category: ['Men'], gender: 'any', occasion_keys: ['festive'] }), plain = product({ class: ['Mugs'], occasion_keys: ['festive'] });
    expect(ids(rankCustomer({ ...shirt, note: null }, catalog([female, male, men, plain]), { ...cfg, rows: { x: { type: 'gift' as const, picks: 2, key: 'festive' } } }))).toEqual([plain.id]);
  });
  it('the past rail fills first, renders last, and no product sits in two rails', () => {
    const tagged = Array.from({ length: 6 }, () => product({ class: ['Chains'], occasion_keys: ['wedding'] }));
    const r = rankCustomer(shirt, catalog([product({ class: ['Studs'], occasion_keys: ['wedding'] }), ...tagged]), { ...x, rows: { x: { ...x.rows.x, picks: 1 } } });
    expect(r.more?.map((s) => s.kind)).toEqual(['occasion', 'past_purchase']);
    expect(r.more?.[1].product_ids.length).toBe(5);   // Every chain left: the occasion rail, which renders first, took none of them.
    const all = r.more!.flatMap((s) => s.product_ids);
    expect(new Set(all).size).toBe(all.length);
  });
  it('every product explains itself in signal names', () => {
    const rows = rankAll(customers, live, liveCfg);
    for (const r of rows) for (const p of r.picks) expect(p.why?.length).toBeGreaterThan(0);
    for (const r of rows) for (const s of r.more ?? []) for (const id of s.product_ids) expect(s.why?.[id]?.length).toBeGreaterThan(0);
  });
  it('is deterministic', () => expect(rankAll(customers, live, liveCfg)).toEqual(rankAll(customers, live, liveCfg)));
  it('past rail stays last and needs a note word and no gift note', () => {
    for (const r of rankAll(customers, live, liveCfg)) {
      const kinds = (r.more ?? []).map((s) => s.kind), i = kinds.indexOf('past_purchase');
      if (i >= 0) expect(i).toBe(kinds.length - 1);
      if (['c04', 'c12', 'c20'].includes(r.customer_id)) expect(i).toBe(-1);
    }
  });
});

describe('why', () => {
  const file = (picks: unknown[], more?: unknown[]) => ({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'y', rule: 'z', rows: [{ customer_id: 'a', picks, ...(more ? { more } : {}) }] });
  it('an old file with no why still parses', () => expect(parseRecs(file([{ product_id: '1', reason_code: 'HAND_SET' }])).rows[0].picks[0].why).toBeUndefined());
  it('takes signal names and nothing else', () => {
    expect(() => parseRecs(file([{ product_id: '1', reason_code: 'HAND_SET', why: ['goes_with:shirt', 'bestseller'] }]))).not.toThrow();
    expect(() => parseRecs(file([{ product_id: '1', reason_code: 'HAND_SET', why: ['<b>free text'] }]))).toThrow(/recommendations/);
    expect(() => parseRecs(file([], [{ kind: 'occasion', label: '', product_ids: ['1'], why: { 2: ['bestseller'] } }]))).toThrow(/recommendations/);
  });
  it('the Plan step reads in plain words', () => {
    const plan = { picks: [{ slot: 'p1', product_id: '1', reason_code: 'OCCASION_MATCH', group: 'wear', why: ['occasion_tag:wedding', 'goes_with:shirt', 'bestseller'] }],
      more: [{ kind: 'occasion', heading: 'More for a wedding', product_ids: ['2', '3'], why: { 2: ['occasion_tag:wedding'], 3: ['occasion_tag:wedding', 'new_arrival'] } }] };
    const html = planEvidence({ plan, drafts: [] } as unknown as CustomerData);
    expect(html).toContain('Tagged for weddings · Goes with your shirt · Bestseller, by the site');
    expect(html).toContain('Tagged for weddings 2 · New on the site 1');
  });
});

describe('weights (R128)', () => {
  const w = ranking.weights;
  it('scores the sum of what matched, the occasion once', () => {
    expect(scoreOf(['occasion_tag:wedding', 'fitted_class', 'goes_with:shirt', 'prior_tag', 'new_arrival'], w)).toBe(140);
    expect(scoreOf(['fallback'], w)).toBe(0);
    expect(scoreOf(['bestseller'], w)).toBe(15);
  });
  it('refuses past at or over occasion, a zero occasion, and a bad or unknown weight', () => {
    expect(() => checkWeights({ ...w, past: 100 })).toThrow(/past/);
    expect(() => checkWeights({ ...w, past: 101 })).toThrow(/past/);
    expect(() => checkWeights({ ...w, occasion: 0, past: 0 })).toThrow(/occasion/);
    expect(() => checkWeights({ ...w, occasion: 11, past: 10 })).toThrow(/outweigh/);
    expect(() => checkWeights({ ...w, season: -1 })).toThrow(/season/);
    expect(() => checkWeights({ ...w, typo: 3 } as never)).toThrow(/unknown/);
    expect(() => checkWeights({ ...w, new: Infinity })).toThrow(/new/);
    expect(() => rankConfig({ ...ranking, weights: { ...w, past: 500 } }, keys, hand)).toThrow(/past/);
    expect(checkWeights(w)).toBe(w);
  });
  it('the hero guard holds whatever the weights: an off-occasion product with a big score does not take p1', () => {
    const season = product({ class: ['Bags'], prior_tags: ['x'] }), tagged = product({ class: ['Studs'], occasion_keys: ['wedding'] });
    const r = rankCustomer({ ...shirt, note: null }, catalog([season, tagged]), x, { ...w, season: 500 });
    expect(ids(r)).toEqual([tagged.id, season.id]);
  });
  it('a weight moves a weighted row, and the hand and new-user rows stay pinned', () => {
    const a = product({ class: ['Studs'], occasion_keys: ['wedding'], prior_tags: ['x'] }), b = product({ class: ['Hoops'], occasion_keys: ['wedding'], badges: ['New'] });
    const one = { ...x, rows: { x: { ...x.rows.x, picks: 1 } } };
    expect(ids(rankCustomer({ ...shirt, note: null }, catalog([a, b]), one, w))).toEqual([a.id]);
    expect(ids(rankCustomer({ ...shirt, note: null }, catalog([a, b]), one, { ...w, new: 30 }))).toEqual([b.id]);
    const past = product({ handle: 'pin-a', class: ['Socks'] }), fit = product({ handle: 'pin-b', class: ['Bags'] });
    const c = { ...cfg, rows: { x: { type: 'wear' as const, picks: 2, key: null, pool: 'trip', hand: ['pin-a', 'pin-b'] } }, pools: { trip: ['Bags'] } };
    expect(ids(rankCustomer(shirt, catalog([past, fit]), c, { ...w, past: 90 }))).toEqual([fit.id, past.id]);
  });
  it('every pick carries score and why, and the row its filter counts', () => {
    const r = rankCustomer(shirt, catalog([product({ class: ['Chains'], occasion_keys: ['wedding'], badges: ['New'] })]), x);
    expect(r.picks[0].score).toBe(120);
    expect(r.pool).toEqual({ filtered: 1, on_occasion: 1, past: 1 });
    expect(() => parseRecs({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'y', rule: 'z', rows: [r], generated_by: rankingBy(cfg, 'y') })).not.toThrow();
    expect(() => parseRecs({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'y', rule: 'z', rows: [{ ...r, pool: { filtered: 'a' } }] })).toThrow(/pool/);
  });
  it('a customer with no row rule is skipped, not fatal', () => {
    expect(rankAll([{ customer_id: 'stranger', occasion: null, note: null }, { ...shirt, note: null }], catalog([product({ occasion_keys: ['wedding'] })]), x).map((r) => r.customer_id)).toEqual(['x']);
  });
  it('says what a change costs: unchanged, sections only, or picks and order', () => {
    const k = (id: string) => ({ product_id: id }) as never, rail = (ids: string[]) => ({ kind: 'occasion', heading: 'H', product_ids: ids }) as never;
    const stored = { picks: [k('1'), k('2')], more: [rail(['3', '4'])] };
    expect(changeOf(stored, stored).kind).toBe('unchanged');
    expect(changeOf(stored, { ...stored, more: [rail(['4', '3'])] })).toEqual({ kind: 'sections', rails: ['H'] });
    expect(changeOf(stored, { ...stored, picks: [k('2'), k('1')] }).kind).toBe('picks');
    expect(changeOf(stored, { ...stored, picks: [k('1'), k('9')] }).kind).toBe('picks');
  });
});

describe.skipIf(!real)('on the real snapshot', () => {
  const rows = real ? rankAll(customers, real, cfg) : [];
  const get = (c: string) => rows.find((r) => r.customer_id === c)!;
  const masc = (p: Product) => p.category.includes('Men') || p.gender === 'male';
  const fem = (p: Product) => p.category.includes('Women') || p.gender === 'female';
  it("c01's p1 and p2 are the owner's anchor at the default weights: Dupki Studs, Chandni Necklace (R134)", () => expect(ids(get('c01')).slice(0, 2)).toEqual(['7492613243014', '7492613406854']));
  it('c20 keeps its rule', () => {
    expect(get('c20').picks.every((p) => p.reason_code === 'NEW_USER_PRIOR')).toBe(true);
    expect(get('c20').picks.map((p) => real!.rows.get(p.product_id)!.handle)).toEqual(ranking.new_user_picks);
  });
  it('no row mixes men and women, and every id is usable', () => {
    for (const r of rows) {
      const ps = [...ids(r), ...(r.more ?? []).flatMap((s) => s.product_ids)].map((i) => real!.rows.get(i)!);
      expect(ps.every((p) => p.excluded_reason === null && p.available)).toBe(true);
      expect(ps.some(masc) && ps.some(fem), r.customer_id).toBe(false);
    }
  });
  it('the past rail keeps its size on thin rows', () => {
    for (const c of ['c06', 'c13', 'c15']) expect(get(c).more?.at(-1)?.kind).toBe('past_purchase');
    expect(['c06', 'c13', 'c15'].map((c) => get(c).more!.at(-1)!.product_ids.length)).toEqual([8, 7, 8]);   // c13's list runs out at 7
  });
  it('the file it writes parses', () => expect(() => parseRecs({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'y', rule: 'z', rows })).not.toThrow());
});
