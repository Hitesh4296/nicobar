// lane gen: expand, renderEmail. Test 7.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import quotes from '../../config/quotes.json' with { type: 'json' };
import { readPromptDir } from '../../scripts/prompt-dir.ts';
import { validateVersion } from '../../src/lib/config/index.ts';
import { expand } from '../../src/lib/render/expand.ts';
import { brandLine, emailPreview, landingLink, pairBody, renderEmail } from '../../src/lib/render/email.ts';
import { imagePaths, renderAll } from '../../src/lib/render/index.ts';
import { renderCatalog } from '../../src/lib/render/catalog.ts';
import { validateRendered } from '../../src/lib/check/index.ts';
import { LANDING_HREF, LOGO, SITE_LINKS } from '../../src/ui/nb.ts';
import type { Catalog, Plan, Product, RenderedJson } from '../../src/contracts/types.ts';
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

describe('the brand line is code\'s (R128)', () => {
  const html = (key: string | null) => { const e = { ...env, occasion_key: key }; return renderEmail(expand(email, 'email', e, cat), cat, e); };
  const F1 = 'Rooted in India, and inspired by journeys across the Indian Ocean.';
  it('F1 by default, for a null key too; B2 for hosting; each with its source as small text', () => {
    for (const k of [null, 'wedding', 'birthday', 'festive']) { expect(html(k)).toContain(F1); expect(html(k)).toMatch(/<small[^>]*>From nicobar\.com<\/small>/); }
    expect(html('hosting')).toContain('Having people over is kind of our favourite thing.');
    expect(html('hosting')).toContain('From nicobar.com/collections/serene-valley-home');
    expect(html('hosting')).not.toContain(F1);
  });
  it('only F1 and B2 ship', () => expect(quotes.brand_lines.lines.map((l) => l.id)).toEqual(['F1', 'B2']));
  it('sits outside the fields, so no word limit or judge counts it, and adds no link', () => {
    const d = expand(email, 'email', env, cat);
    expect(JSON.stringify(d)).not.toContain(F1);
    expect(brandLine(null).id).toBe('F1');
    expect(html(null).match(/<a\b/g)!.length).toBe(renderEmail(d, cat, env).match(/<a\b/g)!.length);
    expect(html(null).indexOf('data-slot="p3"')).toBeLessThan(html(null).indexOf(F1));
  });
  it('prompt v2 gives the model no route to F1 and bars scene words as the reader\'s event; v1 stays as it ran', () => {
    const role = readFileSync('config/prompt/v2/role.md', 'utf8');
    expect(role).not.toContain('Rooted in India');
    expect(role).toMatch(/mehendi, poolside, sangeet/);
    expect(readFileSync('config/prompt/v1/role.md', 'utf8')).toContain('Rooted in India');
    const v = { id: 'v2', kind: 'prompt', content: readPromptDir('config/prompt/v2') } as never;
    expect(validateVersion(v).ok).toBe(true);
  });
});

describe('7 email validates against p1–p3', () => {
  const html = () => renderEmail(expand(email, 'email', env, cat), cat, env);
  const prod = (i: number) => cat.rows.get(env.picks[i].product_id)!;
  it('shows p1 to p3 and no other pick, though the plan has four', () => {
    expect(env.picks).toHaveLength(4);
    expect([...html().matchAll(/<img data-slot="(p\d)"/g)].map((m) => m[1])).toEqual(['p1', 'p2', 'p3']);
    expect(html()).not.toContain(prod(3).handle);
  });
  it('every image is the pick\'s own, every link its product page (X2, X3)', () => {
    const paths = imagePaths({ email: html(), landing_page: null, catalog: '' });
    for (const i of [0, 1, 2]) {
      const canon = prod(i).images.map((m) => new URL(m.src).pathname);
      expect(canon).toContain(paths[`p${i + 1}`]);
    }
    const links = [...html().matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(links)).toEqual(new Set([...[0, 1, 2].map((i) => `https://www.nicobar.com/products/${prod(i).handle}`), ...SITE_LINKS.map(([, h]) => h)]));
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
    expect([...h.matchAll(/<img data-slot="(p\d)"/g)].map((m) => m[1])).toEqual(['p2', 'p3']);
    expect(h).toContain(`/products/${p.handle}`);
  });
  it('uses the lowest position image', () => {
    const p = { ...prod(0), images: [{ ...prod(0).images[0], position: 2, src: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/b.jpg' },
      { ...prod(0).images[0], position: 1, src: 'https://cdn.shopify.com/s/files/1/0270/5129/4854/a.jpg' }] } as Product;
    const c: Catalog = { ...cat, rows: new Map(cat.rows).set(p.id, p) };
    expect(imagePaths({ email: renderEmail(expand(email, 'email', env, c), c, env), landing_page: null, catalog: '' }).p1).toMatch(/a\.jpg$/);
  });
});

describe('the letter: frame, pairing and the one landing link (R132)', () => {
  const plan = (format: 'both' | 'email' = 'both') => ({ ...fxPlanFor(), format, display_name: 'Meera', occasion: "Sister's wedding" });
  const fxPlanFor = () => ({ customer_id: env.customer_id, display_name: null, occasion: null, more: [], picks: env.picks.map((p) => ({ ...p })) }) as never as Plan;
  const model = { email: email, landing_page: { occasion_key: 'x', sections: [{ type: 'hero', slot: 'p1', heading: 'H', line: 'L' }, { type: 'product_grid', items: ['p2', 'p3', 'p4'].map((slot) => ({ slot, caption: 'C' })) }] } };
  const all = () => renderAll(model, plan(), env, cat);
  const fails = (r: RenderedJson, id: string, part: string) => validateRendered(r, env, cat, plan()).filter((c) => c.id === id && c.part === part && !c.pass);
  const p = (i: number) => cat.rows.get(env.picks[i].product_id)!;

  it('pairs copy by the rules: opening, token to pick, two tokens to the lower, the rest to the opening', () => {
    const b = pairBody('Open.\n\n{p1} one.\n\nSecond free.\n\n{p3} and {p2} both.\n\n{p5} unseen.', ['p1', 'p2', 'p3']);
    expect(b.opening).toEqual(['Open.', 'Second free.', '{p5} unseen.']);
    expect(b.slots).toEqual({ p1: ['{p1} one.'], p2: ['{p3} and {p2} both.'] });
    expect(pairBody('{p5} first.\n\nFree.', ['p1']).opening[0]).toBe('Free.');
  });
  it('titles expand in medium weight, inside their own paragraph', () => {
    const h = all().email!;
    expect(h).toMatch(new RegExp(`font-weight:500[^>]*>${p(0).title.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}</a>`));
    expect(h).not.toMatch(/\{p\d\}/);
  });
  it('has header and footer: logo, eyebrow, every site link, the demo line', () => {
    const h = all().email!;
    expect(h).toContain(`For Meera · Sister&#39;s wedding`);
    expect(h.split(`src="${LOGO}" alt="Nicobar"`)).toHaveLength(3);
    for (const [label, href] of SITE_LINKS) { expect(h).toContain(`href="${href}"`); expect(h).toContain(label); }
    expect(h).toContain('A note for you. Nothing here was sent.');
    expect(h).toContain('max-width:600px');
    expect(h).toMatch(/@media \(max-width:480px\)/);
    expect(h).not.toMatch(/unsubscribe/i);
  });
  it('stores a single relative landing link, so the approved hash holds no origin or id', () => {
    const h = all().email!;
    expect(h.match(/data-landing/g)).toHaveLength(1);
    expect(h).toContain(`href="${LANDING_HREF}"`);
    expect(h).not.toMatch(/\/released\//);
  });
  it('resolves on /released to the right draft; review shows it labelled and dead', () => {
    const h = landingLink(all().email!, 'https://x.test/c01');
    expect(h).toContain('href="https://x.test/c01"');
    expect(h).not.toContain(`href="${LANDING_HREF}"`);
    const v = emailPreview(all().email!);
    expect(v).toContain('Live after release');
    expect(v).not.toContain(`href="${LANDING_HREF}"`);
    expect(v).toContain('See your edit');
  });
  it('an email-only run has no landing page, so no button', () => {
    const r = renderAll(model, plan('email'), env, cat);
    expect(r.landing_page).toBeNull();
    expect(r.email).not.toContain('data-landing');
  });
  it('escapes the name in the header', () => {
    const r = renderAll(model, { ...plan(), display_name: '<b>M</b>' }, env, cat);
    expect(r.email).toContain('For &lt;b&gt;M&lt;/b&gt;');
    expect(r.email).not.toContain('<b>M</b>');
  });
  it('the real render passes X1 to X4', () => {
    expect(validateRendered(all(), env, cat, plan()).filter((c) => c.id.startsWith('X') && !c.pass)).toEqual([]);
  });
  it('X2 fires on a foreign image, and on a store image that is not the named logo', () => {
    const add = (src: string, alt = 'Nicobar') => { const r = all(); return { ...r, email: r.email!.replace('</body>', `<img src="${src}" alt="${alt}"></body>`) }; };
    expect(fails(add('https://evil.test/x.png'), 'X2', 'email').map((c) => c.code)).toEqual(['IMG_HOST']);
    expect(fails(add('https://cdn.shopify.com/s/files/1/0270/5129/4854/files/RPSlogo.png'), 'X2', 'email').map((c) => c.code)).toEqual(['IMG_NOT_OF_SELECTED']);
    expect(fails(add('https://cdn.shopify.com/s/files/1/0270/5129/4854/files/Group_1138.svg?v=1633673081'), 'X2', 'email')).toHaveLength(1);
    expect(fails(add(`${LOGO}&width=1`), 'X2', 'email')).toHaveLength(1);
    expect(fails(add(LOGO, 'Other'), 'X2', 'email')).toHaveLength(1);
  });
  it('X3 fires on a foreign link, a near miss of a site link, and the landing link where it does not belong', () => {
    const add = (html: string, href: string) => html.replace('</body>', `<a href="${href}">x</a></body>`);
    const r = all();
    expect(fails({ ...r, email: add(r.email!, 'https://evil.test/') }, 'X3', 'email')).toHaveLength(1);
    expect(fails({ ...r, email: add(r.email!, 'https://www.nicobar.com/pages/about-us?x=1') }, 'X3', 'email')).toHaveLength(1);
    expect(fails({ ...r, email: add(r.email!, 'https://www.nicobar.com/pages/in-the-press') }, 'X3', 'email')).toHaveLength(1);
    expect(fails({ ...r, email: add(r.email!, '/released/other?part=landing_page') }, 'X3', 'email')).toHaveLength(1);
    expect(fails({ ...r, catalog: add(r.catalog, LANDING_HREF) }, 'X3', 'catalog')).toHaveLength(1);
    expect(fails({ ...r, landing_page: null }, 'X3', 'email')).toHaveLength(1);
    expect(fails({ ...r, landing_page: add(r.landing_page!, SITE_LINKS[0][1]) }, 'X3', 'landing_page')).toHaveLength(1);
  });
  it('the catalog shares the header and footer, and passes the same X checks', () => {
    const h = renderCatalog(plan(), cat);
    expect(h).toContain(`src="${LOGO}" alt="Nicobar"`);
    expect(h).toContain('A note for you. Nothing here was sent.');
    expect(h).toContain('For Meera');
  });
  it('the landing header carries the logo', () => expect(all().landing_page).toContain(`src="${LOGO}" alt="Nicobar"`));
});
