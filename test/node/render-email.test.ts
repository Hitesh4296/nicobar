// lane gen: expand, renderEmail. Test 7.
import { describe, expect, it } from 'vitest';
import { expand } from '../../src/lib/render/expand.ts';
import { renderEmail } from '../../src/lib/render/email.ts';
import { imagePaths } from '../../src/lib/render/index.ts';
import type { Catalog, Envelope, Product } from '../../src/contracts/types.ts';
import { fxCatalog, fxEnvelope } from '../fakes/index.ts';

const cat = fxCatalog();
const env = fxEnvelope('fx-both');
const title = (i: number) => cat.rows.get(env.picks[i].product_id)!.title;
const email = { occasion_key: 'diwali', subject: 'A table for <the> evening', preheader: 'Things that sit well together, lit low.',
  body: 'First {p1} is here.\n\nThen {p2} & {p3}.' };

describe('expand', () => {
  it('replaces each token with the snapshot title, verbatim', () => {
    const d = expand(email, 'email', env, cat);
    expect(d.part).toBe('email');
    expect(d.schema).toBe('email/v2');
    expect(d.reader_text).toBe(`First ${title(0)} is here.\n\nThen ${title(1)} & ${title(2)}.`);
    expect(d.fields.map((f) => f.name)).toEqual(['subject', 'preheader', 'body']);
    expect(d.fields[2].raw).toBe(email.body);
    expect(d.fields[2].slot_scope).toBeNull();
  });
  it('a title holding $ is not a replacement pattern', () => {
    const p = { ...cat.usable[0], title: "A $& B $'" } as Product;
    const c: Catalog = { ...cat, rows: new Map([[env.picks[0].product_id, p]]) };
    expect(expand({ body: '{p1}' }, 'email', env, c).reader_text).toBe("A $& B $'");
  });
  it('leaves an unknown token for C2 to fail', () => {
    expect(expand({ body: 'x {p6} {p9} {q}' }, 'email', env, cat).reader_text).toBe('x {p6} {p9} {q}');
  });
  it('landing: reader text is prose, in order, quotes and titles left out; slot scope per field', () => {
    const d = expand({ occasion_key: 'x', sections: [
      { type: 'hero', slot: 'p2', heading: 'Heading here', line: 'Line one' },
      { type: 'story', text: 'A story with {p1}' },
      { type: 'quote', quote_id: 'E4' },
      { type: 'product_grid', items: [{ slot: 'p3', caption: 'Cap three' }, { slot: 'p4', caption: 'Cap four' }] },
      { type: 'pairing', slots: ['p1', 'p3'], line: 'Pair line' },
      { type: 'packing_list', items: [{ slot: 'p1', note: 'Note one' }] },
      { type: 'feature', slot: 'p4', line: 'Feature line' },
    ] }, 'landing_page', env, cat);
    expect(d.schema).toBe('landing/v3');
    expect(d.reader_text).toBe(['Heading here', 'Line one', `A story with ${title(0)}`, 'Cap three', 'Cap four', 'Pair line', 'Note one', 'Feature line'].join('\n\n'));
    const scope = Object.fromEntries(d.fields.map((f) => [f.name, f.slot_scope]));
    expect(scope).toEqual({
      'sections[0].heading': ['p2'], 'sections[0].line': ['p2'], 'sections[1].text': null,
      'sections[3].items[0].caption': ['p3'], 'sections[3].items[1].caption': ['p4'],
      'sections[4].line': ['p1', 'p3'], 'sections[5].items[0].note': ['p1'], 'sections[6].line': ['p4'] });
  });
  it('does not throw on a shape C1 will fail: E3 still needs a row', () => {
    expect(expand({ subject: 3, body: null }, 'email', env, cat).reader_text).toBe('');
    expect(expand({ sections: 'x' }, 'landing_page', env, cat).fields).toEqual([]);
    expect(expand({ sections: [null, { type: 'nope' }, { type: 'product_grid', items: 7 }, { type: 'pairing', slots: 'p1', line: 'L' }] }, 'landing_page', env, cat).reader_text).toBe('L');
  });
});

describe('7 email validates against p1–p3', () => {
  const html = () => renderEmail(expand(email, 'email', env, cat), cat, env);
  const prod = (i: number) => cat.rows.get(env.picks[i].product_id)!;
  it('shows p1 to p3 and no other pick, though the plan has four', () => {
    expect(env.picks).toHaveLength(4);
    expect([...html().matchAll(/data-slot="(p\d)"/g)].map((m) => m[1])).toEqual(['p1', 'p2', 'p3']);
    expect(html()).not.toContain(prod(3).handle);
  });
  it('every image is the pick\'s own, every link its product page (X2, X3)', () => {
    const paths = imagePaths({ email: html(), landing_page: null, catalog: '' });
    for (const i of [0, 1, 2]) {
      const canon = prod(i).images.map((m) => new URL(m.src).pathname);
      expect(canon).toContain(paths[`p${i + 1}`]);
    }
    const links = [...html().matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(links)).toEqual(new Set([0, 1, 2].map((i) => `https://www.nicobar.com/products/${prod(i).handle}`)));
  });
  it('escapes model text, carries no price, keeps paragraphs', () => {
    expect(html()).toContain('A table for &lt;the&gt; evening');
    expect(html()).not.toContain('<the>');
    expect(html()).toContain(' &amp; ');
    expect(html().match(/<p\b/g)!.length).toBeGreaterThanOrEqual(2);
    for (const i of [0, 1, 2]) for (const v of prod(i).variants) expect(html()).not.toContain(`>${v.price}<`);
    expect(html()).not.toMatch(/₹|Rs\.?\s?\d/);
  });
  it('a title with markup is escaped', () => {
    const p = { ...prod(0), title: 'A <b> "T"' } as Product;
    const c: Catalog = { ...cat, rows: new Map(cat.rows).set(p.id, p) };
    expect(renderEmail(expand(email, 'email', env, c), c, env)).toContain('A &lt;b&gt; &quot;T&quot;');
  });
  it('a pick with no image still renders its card', () => {
    const p = { ...prod(0), images: [] } as Product;
    const c: Catalog = { ...cat, rows: new Map(cat.rows).set(p.id, p) };
    const h = renderEmail(expand(email, 'email', env, c), c, env);
    expect([...h.matchAll(/data-slot="(p\d)"/g)].map((m) => m[1])).toEqual(['p2', 'p3']);
    expect(h).toContain(`/products/${p.handle}`);
  });
  it('uses the lowest position image', () => {
    const p = { ...prod(0), images: [{ ...prod(0).images[0], position: 2, src: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/b.jpg' },
      { ...prod(0).images[0], position: 1, src: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/a.jpg' }] } as Product;
    const c: Catalog = { ...cat, rows: new Map(cat.rows).set(p.id, p) };
    expect(imagePaths({ email: renderEmail(expand(email, 'email', env, c), c, env), landing_page: null, catalog: '' }).p1).toMatch(/a\.jpg$/);
  });
});
