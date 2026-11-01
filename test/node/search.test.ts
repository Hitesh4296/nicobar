// R141: search, the code gates on what a model chose, and rank from saved queries.
import { describe, expect, it } from 'vitest';
import ranking from '../../config/ranking.json' with { type: 'json' };
import type { Catalog, Product } from '../../src/contracts/types.ts';
import { poolOf, rankConfig, rankCustomer, type RankCustomer } from '../../src/lib/rank/index.ts';
import { parseRecs } from '../../src/lib/recs.ts';
import { gatePlan, statedGender, type PlanRow, type QueriesFile } from '../../src/lib/search/gate.ts';
import { buildIndex, counts, queryOfParams, readProducts, search } from '../../src/lib/search/index.ts';
import { offered, plannerRequest, plannerSchema, toFilters } from '../../src/lib/search/planner.ts';
import { denied, facetsOf, vocabularyOf } from '../../src/lib/search/vocabulary.ts';
import { snapshotCatalog } from '../../scripts/eval.ts';

let n = 0;
const P = (facets: Record<string, string[]>, over: Partial<Product> = {}): Product => ({ id: String(++n), handle: `p-${n}`, title: `P ${n}`, url: '', body_text_clean: '', category: ['Accessories'], subcategory: ['Sub'], class: [facets.class?.[0] ?? `C${n}`], subclass: [],
  wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [], room_or_use: [], collection: [], campaign: [], occasion_keys: [], prior_tags: [], material: null, material_group: null, colours: [], gender: null,
  design_group: null, badges: [], is_bestseller_gift: false, available: true, variants: [], images: [], excluded_reason: null, content_sha256: '', facets, ...over });
const rows = [...Array.from({ length: 5 }, () => P({ occasion: ['Wedding'], class: ['Kurta'] })), ...Array.from({ length: 4 }, () => P({ occasion: ['Wedding', 'Festive'], class: ['Dupatta'], pattern: ['Embroidered'] })), P({ occasion: ['Resort'], class: ['Kurta'] }), ...Array.from({ length: 4 }, () => P({ recipient: ['him'], class: ['Socks'] }))];
const index = buildIndex(rows);
const ctx = (over = {}) => ({ occasion: "Sister's wedding", past: null, admit: () => true, ...over });
const row = (all: Record<string, string[]>, sections: PlanRow['sections'] = []): PlanRow => ({ primary: { purpose: 'p', all }, sections });

describe('vocabulary', () => {
  it('reads families from real tags, and the denylist holds', () => {
    const f = facetsOf(['Filteroccasion_Wedding', 'Filterclass_Kurta', 'Campaign_x', 'campaign_y', 'metafield_sync', 'MATERIAL_100% Cotton', 'Material Group_Cotton'], { colours: ['Ivory'], gift_recipient: ['him'], gift_occasion: [] });
    expect(f).toEqual({ occasion: ['Wedding'], class: ['Kurta'], campaign: ['x', 'y'], material: ['Cotton'], colour: ['Ivory'], recipient: ['him'] });
    for (const t of ['metafield_sync', 'sync-product', 'Product_Size_Guide_x', 'Product_Variant', 'apparel_product', 'grouping_a', 'MATERIAL_100%', 'block-print-ivory']) expect(denied(t), t).toBe(true);
  });
  it('counts over the rows it is given', () => expect(vocabularyOf(rows).occasion[0]).toEqual({ value: 'Wedding', count: 9 }));
});

describe('search', () => {
  it('ORs within a family, ANDs across, and honours not', () => {
    expect(search({ all: { class: ['Kurta', 'Dupatta'] } }, index).count).toBe(10);
    expect(search({ all: { class: ['Kurta'], occasion: ['Wedding'] } }, index).count).toBe(5);
    expect(search({ all: { occasion: ['Wedding'] }, not: { pattern: ['Embroidered'] } }, index).count).toBe(5);
    expect(search({ all: { occasion: ['Nope'] } }, index).count).toBe(0);
  });
  it('sorts by place, and a chip counts with its own family set aside', () => {
    const a = P({ class: ['Bags'] }), b = P({ class: ['Bags'] }, { merch_rank: { 'all-women': 4 } }), i = buildIndex([a, b]);
    expect(search({ all: {}, sort: 'merchandising' }, i).ids).toEqual([b.id, a.id]);
    const c = counts({ all: { class: ['Kurta'] } }, index);
    expect(c.class.find((x) => x.value === 'Dupatta')?.count).toBe(4);
    expect(c.occasion.find((x) => x.value === 'Wedding')?.count).toBe(5);
  });
  const real = snapshotCatalog();
  it.skipIf(!real)('stays under 200 ms on the real catalog', () => {
    const t = performance.now(), i = buildIndex(real!.usable);
    search({ all: { occasion: ['Wedding'], class: ['Kurta'], pattern: ['Embroidered'] } }, i); counts({ all: { occasion: ['Wedding'] } }, i);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('the gates', () => {
  it('drops a value not in the vocabulary, and logs it', () => {
    const g = gatePlan(row({ occasion: ['Wedding'], class: ['Tiara'] }), ctx(), index);
    expect(g.primary?.all).toEqual({ occasion: ['Wedding'] });
    expect(g.log[0]).toContain('class=Tiara');
  });
  it('sets recipient or a gendered family only when the customer stated it', () => {
    expect(statedGender("Father's sixtieth")).toBe('him');
    expect(statedGender("Mother's birthday")).toBe('her');
    expect(statedGender("Sister's wedding")).toBeNull();
    expect(statedGender('Gallery opening', 'f')).toBe('her');
    expect(gatePlan(row({ occasion: ['Wedding'], recipient: ['him'] }), ctx(), index).primary?.all).toEqual({ occasion: ['Wedding'] });
    expect(gatePlan(row({ recipient: ['him'] }), ctx({ occasion: "Father's sixtieth" }), index).primary?.all).toEqual({ recipient: ['him'] });
    const men = buildIndex([P({ category: ['Men'], class: ['A'] }), P({ category: ['Men'], class: ['A'] }), P({ category: ['Men'], class: ['A'] })]);
    expect(gatePlan(row({ category: ['Men'], class: ['A'] }), ctx(), men).primary?.all).toEqual({ class: ['A'] });
  });
  it('zero results relaxes the last filter, logged, to one filter and no further', () => {
    const g = gatePlan(row({ occasion: ['Resort'], pattern: ['Embroidered'], class: ['Dupatta'] }), ctx(), index);
    expect(g.primary).toBeNull();   // Resort alone is one product
    expect(g.log.filter((l) => l.startsWith('relaxed')).length).toBe(2);
    const ok = gatePlan(row({ class: ['Kurta'], pattern: ['Embroidered'] }), ctx(), index);
    expect(ok.primary?.all).toEqual({ class: ['Kurta'] });
  });
  it('a query under 3 results is dropped with a reason', () => {
    const g = gatePlan(row({ class: ['Kurta'] }, [{ purpose: 'thin', all: { occasion: ['Resort'] } }]), ctx(), index);
    expect(g.sections).toEqual([]);
    expect(g.log[0]).toContain('"thin": 1 results');
  });
  it('past purchase supplies a section only, and only when there is one', () => {
    const past = { purpose: 'pair', all: { class: ['Socks'] }, from_past: true };
    expect(gatePlan(row({ class: ['Kurta'] }, [past]), ctx(), index).sections).toEqual([]);
    expect(gatePlan(row({ class: ['Kurta'] }, [past]), ctx({ past: 'shirt' }), index).sections.length).toBe(1);
    expect(gatePlan({ primary: past, sections: [] }, ctx({ past: 'shirt' }), index).primary).not.toHaveProperty('from_past');
  });
});

describe('the planner request', () => {
  const v = vocabularyOf(rows);
  it('sends occasion, past item and the flag, never a name', () => {
    const r = plannerRequest({ occasion: "Sister's wedding", past_item: 'shirt', new_user: false }, v, 'P', 'claude-haiku-5-5');
    const text = JSON.stringify(r);
    expect(r.messages[0].content).toContain('<past_item>shirt</past_item>');
    for (const banned of ['Meera', 'Das', 'c01', 'first_name']) expect(text).not.toContain(banned);
  });
  it('is data only: no tools in the request, so the model finds nothing itself', () => {
    const r = plannerRequest({ occasion: 'x', past_item: null, new_user: true }, v, 'P', 'claude-haiku-5-5');
    expect(r).not.toHaveProperty('tools'); expect(r).not.toHaveProperty('tool_choice'); expect(r).not.toHaveProperty('mcp_servers');
  });
  it('limits the schema to real values', () => {
    const s = JSON.stringify(plannerSchema(v));
    expect(s).toContain('occasion=Wedding');
    expect(offered(v)).not.toContain('occasion=Nope');
    expect(toFilters(['class=Kurta', 'class=Dupatta', 'a=b=c'])).toEqual({ class: ['Kurta', 'Dupatta'], a: ['b=c'] });
  });
});

describe('rank from saved queries', () => {
  const c: RankCustomer = { customer_id: 'x', occasion: "Sister's wedding", note: null };
  const q = (r: PlanRow): QueriesFile => ({ version: 'queries/v1', synthetic: true, model: 'm', prompt_sha256: 'h', date: 'd', snapshot_id: 's', rows: { x: r } });
  const cfg = (r: PlanRow, over = {}) => ({ ...rankConfig(ranking, {}, {}, q(r)), rows: { x: { type: 'wear' as const, picks: 2, key: 'wedding', ...over } } });
  const cat = { usable: rows, rows: new Map(rows.map((p) => [p.id, p])) } as unknown as Catalog;
  const plan = row({ class: ['Dupatta'] }, [{ purpose: 'kurtas', all: { occasion: ['Wedding'], class: ['Kurta'] } }]);
  it('takes the hero from the primary, rails from sections, headings from values, and repeats exactly', () => {
    const a = rankCustomer(c, cat, cfg(plan)), b = rankCustomer(c, cat, cfg(plan));
    expect(a).toEqual(b);
    expect(rows.find((p) => p.id === a.picks[0].product_id)!.class).toEqual(['Dupatta']);
    expect(a.picks[0].why).toContain('query_match');
    expect(a.more?.find((m) => m.kind === 'occasion_category')?.label).toBe('Wedding Kurtas');
    expect(() => parseRecs({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'y', rule: 'z', rows: [a] })).not.toThrow();
  });
  it('holds gender: a gender-free row never shows a gendered product a query found', () => {
    const mixed = [...rows, ...['A', 'B', 'C'].map((k) => P({ occasion: ['Wedding'], class: [k] }, { category: ['Women'], gender: 'female' }))];
    const r = rankCustomer(c, { usable: mixed, rows: new Map(mixed.map((p) => [p.id, p])) } as unknown as Catalog, cfg(row({ occasion: ['Wedding'] })));
    expect([...r.picks.map((p) => p.product_id), ...(r.more ?? []).flatMap((m) => m.product_ids)].some((id) => mixed.find((p) => p.id === id)!.gender === 'female')).toBe(false);
  });
  it('falls back to the row rules with no query, or none that survives the gates', () => {
    const tagged = P({ class: ['Studs'] }, { occasion_keys: ['wedding'] }), u = [...rows, tagged], k = { usable: u, rows: new Map(u.map((p) => [p.id, p])) } as unknown as Catalog;
    expect(rankCustomer(c, k, cfg(row({ class: ['Tiara'] }))).picks[0].product_id).toBe(tagged.id);
  });
  it('a wear row keeps home out of the picks, unless the query found only home', () => {
    const mug = ['A', 'B', 'C'].map((k) => P({ gift_occasion: ['Wedding'], class: [k] }, { category: ['House & Home'] })), studs = ['D', 'E', 'F'].map((k) => P({ gift_occasion: ['Wedding'], class: [k] }));
    const u = [...mug, ...studs], k = { usable: u, rows: new Map(u.map((p) => [p.id, p])) } as unknown as Catalog, of = (id: string) => u.find((p) => p.id === id)!;
    expect(rankCustomer(c, k, cfg(row({ gift_occasion: ['Wedding'] }))).picks.every((p) => !of(p.product_id).category.includes('House & Home'))).toBe(true);
    const only = { usable: mug, rows: new Map(mug.map((p) => [p.id, p])) } as unknown as Catalog;
    expect(rankCustomer(c, only, cfg(row({ gift_occasion: ['Wedding'] }))).picks.length).toBe(2);
  });
  it('rank reads what the route reads for one query', () => {
    const r = cfg(row({ occasion: ['Wedding'], class: ['Kurta'] }), {});
    const route = readProducts(queryOfParams(new URLSearchParams('occasion=Wedding&class=Kurta&limit=2&offset=1')), index).ids;
    expect([...poolOf(c, cat, r).plan!.primary].sort()).toEqual([...route].sort());
  });
  it('names the queries in generated_by', async () => {
    const { rankingBy } = await import('../../src/lib/rank/index.ts');
    expect(rankingBy(cfg(plan), 's').queries).toEqual({ model: 'm', prompt_sha256: 'h', date: 'd' });
  });
});
