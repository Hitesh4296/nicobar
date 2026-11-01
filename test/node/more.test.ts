// R123: `more` from the recs row to the page. The row is untrusted, the sections are code-set, and a bad one never fails a customer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import shapes from '../../config/shapes.json' with { type: 'json' };
import { contentSha256 } from '../../src/contracts/lib.ts';
import type { Catalog, MoreSection, Plan, RecRow, ShapesFile } from '../../src/contracts/types.ts';
import { validateRendered } from '../../src/lib/check/index.ts';
import { ingestTsv } from '../../src/lib/ingest.ts';
import { planCustomer } from '../../src/lib/plan.ts';
import { parseRecs } from '../../src/lib/recs.ts';
import { countMore, readCards, renderCatalog } from '../../src/lib/render/catalog.ts';
import { renderLanding } from '../../src/lib/render/landing-v2.ts';
import { expandLanding, fxCase, voiceSql } from '../../scripts/seed.ts';
import { fxCatalog, fxPinned } from '../fakes/index.ts';

const cat = fxCatalog();
const pool = cat.usable.map((p) => p.id);
const HEADER = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\n';
const item = (note = 'Bought the indigo travel shirt.', occasion = "Mother's <b>birthday") => ingestTsv(`${HEADER}a\tAsha\tRao\t${occasion}\t${note}\n`)[0];
const section = (over: Partial<MoreSection> = {}): MoreSection => ({ kind: 'occasion', label: '', product_ids: [pool[5]], ...over });
const row = (more?: MoreSection[]): RecRow => ({ customer_id: 'a', picks: pool.slice(0, 4).map((product_id) => ({ product_id, reason_code: 'OCCASION_MATCH' })), ...(more ? { more } : {}) });
const planOf = (r: RecRow, it = item(), c: Catalog = cat) => planCustomer(it, r, {}, c, fxPinned, shapes as ShapesFile);
const parse = (r: unknown) => parseRecs({ version: 'recommendations/v1', synthetic: true, as_of: 'x', snapshot_id: 'x', rule: 'x', rows: [r] });
const ids = (n: number, from = 4) => Array.from({ length: n }, (_, i) => `m${from + i}`);
const failed = (rs: { pass: boolean; severity: string; id: string }[]) => rs.filter((r) => !r.pass && r.severity === 'hard').map((r) => r.id);
const wide = () => {
  const c = fxCase('GOOD-c16');
  const free = pool.filter((id) => !c.plan.picks.some((p) => p.product_id === id));
  const plan: Plan = { ...c.plan, more: [{ kind: 'occasion', heading: 'More for <you>', product_ids: free.slice(0, 2) }] };
  return { ...c, plan, free };
};
const landing = (w: ReturnType<typeof wide>) => renderLanding(expandLanding(w.model.landing_page!, w.envelope, cat), cat, w.envelope, w.plan);

afterEach(() => { vi.restoreAllMocks(); });

describe('parseRecs bounds more', () => {
  it('a row without more parses as before, and a good one passes', () => {
    expect(parse(row()).rows[0]).toEqual(row());
    expect(parse(row([section()])).rows[0].more).toHaveLength(1);
  });
  const over: [string, unknown][] = [
    ['not a list', 'x'],
    ['7 sections', Array.from({ length: 7 }, (_, i) => section({ product_ids: [`s${i}`] }))],
    ['an empty section', [section({ product_ids: [] })]],
    ['25 ids in a section', [section({ product_ids: ids(25) })]],
    ['61 ids in a row', [section({ product_ids: ids(24) }), section({ product_ids: ids(24, 100) }), section({ product_ids: ids(13, 200) })]],
    ['an id twice in the row', [section({ product_ids: ['x'] }), section({ product_ids: ['x'] })]],
    ['an id that is a pick', [section({ product_ids: [pool[0]] })]],
    ['a second past_purchase', [section({ kind: 'past_purchase', label: 'shirt', product_ids: ['x'] }), section({ kind: 'past_purchase', label: 'stole', product_ids: ['y'] })]],
    ['an unknown kind', [{ ...section(), kind: 'trending' }]],
    ['an extra key', [{ ...section(), price: 1 }]],
    ['a label on occasion', [section({ label: 'x' })]],
    ['past_purchase with a title, not a word', [section({ kind: 'past_purchase', label: 'Hornbill Shirt' })]],
    ['occasion_category with markup', [section({ kind: 'occasion_category', label: '<b>Earrings' })]],
  ];
  for (const [name, more] of over) it(`throws on ${name}`, () => expect(() => parse(row(more as MoreSection[]))).toThrow(/recommendations/));
  it('60 ids in a row pass', () => expect(() => parse(row([section({ product_ids: ids(24) }), section({ product_ids: ids(24, 100) }), section({ product_ids: ids(12, 200) })]))).not.toThrow());
});

describe('planCustomer resolves more', () => {
  it('headings from code, in page order', () => {
    const plan = planOf(row([section({ product_ids: [pool[5]] }), section({ kind: 'occasion_category', label: 'Earrings', product_ids: [pool[6]] }), section({ kind: 'past_purchase', label: 'shirt', product_ids: [pool[7]] })]));
    expect(plan.more?.map((s) => s.heading)).toEqual(["Earrings for Mother's <b>birthday", "More for Mother's <b>birthday", 'To go with your shirt']);
  });
  it('a past label not in the note is dropped and logged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const plan = planOf(row([section({ kind: 'past_purchase', label: 'kurta' })]));
    expect(plan.more).toBeUndefined();
    expect(plan.outcome).toEqual({ kind: 'ready' });
    expect(log.mock.calls[0][0]).toContain('MORE_PAST_LABEL');
  });
  it('a word inside a word does not count', () => expect(planOf(row([section({ kind: 'past_purchase', label: 'shirt' })]), item('Bought the sweatshirt.')).more).toBeUndefined());
  it('new_user: the past section drops, the occasion section stays', () => {
    const plan = planOf(row([section({ kind: 'past_purchase', label: 'shirt', product_ids: [pool[6]] }), section()]), item('none'));
    expect(plan.more?.map((s) => s.kind)).toEqual(['occasion']);
  });
  it('blank occasion keeps more, with its own headings (c20)', () => {
    const plan = planOf(row([section(), section({ kind: 'occasion_category', label: 'Earrings', product_ids: [pool[6]] }), section({ kind: 'past_purchase', label: 'shirt', product_ids: [pool[7]] })]), item('none', ''));
    expect(plan.more?.map((s) => s.heading)).toEqual(['Earrings', 'More from Nicobar']);
  });
  it('a note saying it was a gift gets no past_purchase rail', () =>
    expect(planOf(row([section({ kind: 'past_purchase', label: 'scarf' })]), item('Bought the block-print scarf as a gift.')).more).toBeUndefined());
  it('a note word that is no catalog class still counts', () =>
    expect(planOf(row([section({ kind: 'past_purchase', label: 'weekender' })]), item('Bought the woven weekender.')).more?.[0].heading).toBe('To go with your weekender'));
  it('a bad id drops alone, an empty section drops, the customer stays ready', () => {
    const excluded = { ...cat.rows.get(pool[6])!, excluded_reason: 'hidden' };
    const c = { ...cat, rows: new Map(cat.rows).set(excluded.id, excluded) } as unknown as Catalog;
    const plan = planOf(row([section({ product_ids: ['gone', pool[6], pool[5]] }), section({ kind: 'occasion_category', label: 'Rings', product_ids: ['gone2'] })]), item(), c);
    expect(plan.more).toEqual([{ kind: 'occasion', heading: "More for Mother's <b>birthday", product_ids: [pool[5]] }]);
    expect(plan.outcome).toEqual({ kind: 'ready' });
  });
  it('picks decide the outcome: bad picks fail with no more on the plan', () => {
    const plan = planOf({ ...row([section()]), picks: [] });
    expect(plan.outcome).toMatchObject({ kind: 'failed' });
    expect(plan.more).toBeUndefined();
  });
  it('a row without more leaves the plan key absent', () => expect('more' in planOf(row())).toBe(false));
  it('the note never reaches the plan, only the label does', () => {
    const out = JSON.stringify(planOf(row([section({ kind: 'past_purchase', label: 'shirt' })])));
    expect(out).toContain('To go with your shirt');
    expect(out).not.toContain('indigo');
  });
});

describe('render and X checks', () => {
  for (const [part, html] of [['catalog', (w: ReturnType<typeof wide>) => renderCatalog(w.plan, cat)], ['landing_page', landing]] as const) {
    it(`${part}: sections after the picks, escaped, marked data-more, and X passes`, () => {
      const w = wide(), h = html(w);
      expect(h).toContain('More for &lt;you&gt;');
      expect(h).not.toContain('<you>');
      expect(h.lastIndexOf('data-slot=')).toBeLessThan(h.indexOf('data-more='));
      expect(h.match(/<img data-more=/g)).toHaveLength(2);
      expect(h).not.toContain('OCCASION_MATCH');
      expect(h).not.toContain('₹');
      expect(failed(validateRendered({ email: null, landing_page: null, catalog: renderCatalog(w.plan, cat), [part]: h }, w.envelope, cat, w.plan))).toEqual([]);
    });
    it(`${part}: a foreign image in more fires X2`, () => {
      const w = wide(), foreign = cat.rows.get(w.free[5])!.images[0].src;
      const h = html(w).replace(/(data-more="[^"]*" src=")[^"]*/, `$1${foreign}`);
      expect(failed(validateRendered({ email: null, landing_page: null, catalog: renderCatalog(w.plan, cat), [part]: h }, w.envelope, cat, w.plan))).toContain('X2');
    });
    it(`${part}: a foreign link in more fires X3`, () => {
      const w = wide(), foreign = cat.rows.get(w.free[5])!.url;
      const h = html(w).replace(/(data-more="[^"]*" href=")[^"]*/, `$1${foreign}`);
      expect(failed(validateRendered({ email: null, landing_page: null, catalog: renderCatalog(w.plan, cat), [part]: h }, w.envelope, cat, w.plan))).toContain('X3');
    });
    it(`${part}: one more card showing another more product's image fires X1`, () => {
      const w = wide(), other = cat.rows.get(w.plan.more![0].product_ids[1])!.images[0].src;
      const h = html(w).replace(/(data-more="[^"]*" src=")[^"]*/, `$1${other}`);
      expect(failed(validateRendered({ email: null, landing_page: null, catalog: renderCatalog(w.plan, cat), [part]: h }, w.envelope, cat, w.plan))).toContain('X1');
    });
  }
  it('email stays picks only: a more product there fires', () => {
    const w = wide(), p = cat.rows.get(w.plan.more![0].product_ids[0])!;
    const email = renderCatalog(w.plan, cat);   // holds more cards, so it stands in for an email that grew them
    expect(failed(validateRendered({ email, landing_page: null, catalog: renderCatalog(w.plan, cat) }, w.envelope, cat, w.plan))).toEqual(expect.arrayContaining(['X2', 'X3']));
    expect(email).toContain(p.handle);
  });
  it('readCards reads the picks exactly; countMore counts the rest', () => {
    const w = wide();
    expect(readCards(renderCatalog(w.plan, cat))).toEqual(readCards(renderCatalog({ ...w.plan, more: undefined }, cat)));
    expect(countMore(renderCatalog(w.plan, cat))).toBe(2);
    expect(countMore(renderCatalog({ ...w.plan, more: undefined }, cat))).toBe(0);
  });
  it('an old plan with no more renders the same bytes as an empty one', () =>
    expect(renderCatalog({ ...wide().plan, more: undefined }, cat)).toBe(renderCatalog({ ...wide().plan, more: [] }, cat)));
  it('the catalog hash changes with more', async () => {
    const w = wide(), hash = (catalog: string) => contentSha256('e', 'm', JSON.stringify({ email: null, landing_page: null, catalog }));
    expect(await hash(renderCatalog(w.plan, cat))).not.toBe(await hash(renderCatalog({ ...w.plan, more: undefined }, cat)));
  });
  it('seed --voice carries more through the real render', async () => {
    const w = wide();
    const sql = await voiceSql([{ plan: w.plan, envelope: w.envelope, request_sha256: 'r', message: {}, model_json: w.model, checks: [] }], cat, 'wide');
    expect(sql.join()).toContain('data-more=');
  });
});
