// page lane tests 1, 3, 7 (structure), 8: the renderers, against fixture catalog rows.
import { describe, expect, it } from 'vitest';
import { readCards, renderCatalog } from '../../src/lib/render/catalog.ts';
import { renderLanding } from '../../src/lib/render/landing-v2.ts';
import { imagePaths } from '../../src/lib/render/index.ts';
import { renderEmail } from '../../src/lib/render/email.ts';
import { expand } from '../../src/lib/render/expand.ts';
import { validateRendered } from '../../src/lib/check/index.ts';
import { LOGO } from '../../src/ui/nb.ts';
import { fxCatalog } from '../fakes/index.ts';
import { fxCase, expandLanding } from '../../scripts/seed.ts';
import type { Plan } from '../../src/contracts/types.ts';

const cat = fxCatalog();
const landing = (id: string, over: Partial<Plan> = {}, model?: object) => {
  const c = fxCase(id);
  const plan = { ...c.plan, ...over };
  return { plan, html: renderLanding(expandLanding((model ?? c.model.landing_page) as Record<string, unknown>, c.envelope, cat), cat, c.envelope, plan) };
};
const body = (html: string) => html.split('</style>')[1];
const imgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(tag)?.[1];

const TREE = { occasion_key: 'diwali', sections: [
  { type: 'hero', slot: 'p1', heading: 'The table, this Diwali', line: 'A line about {p1}.' },
  { type: 'story', text: 'A story with {p2} inside it.' },
  { type: 'product_grid', items: [{ slot: 'p2', caption: 'Caption two.' }, { slot: 'p3', caption: 'Caption three.' }, { slot: 'p4', caption: 'Caption four.' }] },
  { type: 'pairing', slots: ['p5', 'p6'], line: 'A pair, for one evening.' },
  { type: 'quote', quote_id: 'E4' },
  { type: 'packing_list', items: [{ slot: 'p2', note: 'Goes in first' }, { slot: 'p3', note: 'Then this' }, { slot: 'p4', note: 'Last' }] },
  { type: 'feature', slot: 'p5', line: 'First feature line.' },
  { type: 'feature', slot: 'p6', line: 'Second feature line.' },
] };

describe('test 1: sample tree renders every component', () => {
  const { html } = landing('GOOD-c16', {}, TREE);
  for (const cls of ['nb-hero--split', 'nb-text', 'nb-products', 'nb-duo', 'nb-band', 'nb-packing', 'nb-split']) {
    it(cls, () => expect(html).toContain(cls));
  }
  it('expands tokens to the snapshot title', () => {
    const c = fxCase('GOOD-c16');
    expect(html).not.toMatch(/\{p\d\}/);
    expect(html).toContain(cat.rows.get(c.plan.picks[1].product_id)!.title.replaceAll('&', '&amp;').replaceAll("'", '&#39;'));
  });
  it('quote comes from config with its source in plain text', () => {
    expect(html).toContain('Light the diya, set a flower down, and begin.');
    expect(html).toContain('From nicobar.com/pages/the-brass-story');
  });
  it('feature alternates by code', () => expect(body(html).match(/nb-split--reverse/g)).toHaveLength(1));
  it('no price, no script, no event handler', () => {
    expect(html).not.toMatch(/₹|Rs\.|<script|\son\w+=/i);
    for (const p of cat.usable) for (const v of p.variants) expect(html).not.toContain(`>${v.price}<`);
  });
  it('a ghost slot and an unknown section render nothing, they do not throw', () => {
    const bad = { sections: [{ type: 'hero', slot: 'p9', heading: 'x', line: 'y' }, { type: 'carousel' }, { type: 'quote', quote_id: 'E9' }, 'junk'] };
    expect(() => landing('GOOD-c16', {}, bad)).not.toThrow();
  });
});

describe('test 3: alt = title, X4 holds', () => {
  for (const [name, html, plan] of [['landing', landing('GOOD-c16', {}, TREE).html, fxCase('GOOD-c16').plan],
    ['catalog', renderCatalog(fxCase('GOOD-c16').plan, cat), fxCase('GOOD-c16').plan]] as const) {
    it(`${name}: each img has alt, width, height, slot, and its pick's title`, () => {
      expect(imgs(html).length).toBeGreaterThan(0);
      for (const tag of imgs(html).filter((t) => !t.includes(LOGO))) {
        const pick = plan.picks.find((p) => p.slot === attr(tag, 'data-slot'))!;
        const p = cat.rows.get(pick.product_id)!;
        expect(attr(tag, 'alt')).toBe(p.title.replaceAll('&', '&amp;').replaceAll("'", '&#39;'));
        expect(Number(attr(tag, 'width'))).toBeGreaterThan(0);
        expect(Number(attr(tag, 'height'))).toBeGreaterThan(0);
        expect(attr(tag, 'src')).toMatch(/^https:\/\/cdn\.shopify\.com\//);
      }
    });
  }
  it('imagePaths finds each slot at its canonical path', () => {
    const c = fxCase('GOOD-c16');
    const paths = imagePaths({ email: null, landing_page: null, catalog: renderCatalog(c.plan, cat) });
    for (const p of c.plan.picks) {
      expect(cat.rows.get(p.product_id)!.images.map((i) => new URL(i.src_canonical).pathname)).toContain(paths[p.slot]);
    }
  });
  it('catalog links are the pick pages, no prose, no price, no reason code', () => {
    const c = fxCase('GOOD-c16');
    const html = renderCatalog(c.plan, cat);
    for (const p of c.plan.picks) expect(html).toContain(`href="${cat.rows.get(p.product_id)!.url}"`);
    expect(html).not.toMatch(/OCCASION_MATCH|NEW_USER_PRIOR|₹/);
  });
});

describe('X1 link integrity: every pick link is tied to its card', () => {
  const c = fxCase('GOOD-c16');
  const parts = {
    email: renderEmail(expand({ subject: 'S', preheader: 'P', body: 'B' }, 'email', c.envelope, cat), cat, c.envelope),
    landing_page: landing('GOOD-c16', {}, TREE).html,
    catalog: renderCatalog(c.plan, cat),
  };
  const mismatches = (part: keyof typeof parts, html: string) =>
    validateRendered({ email: null, landing_page: null, catalog: '', [part]: html }, c.envelope, cat, c.plan)
      .filter((r) => r.code === 'LINK_MISMATCH');

  it('the review page still reads the marked catalog', () => expect(readCards(parts.catalog)).toHaveLength(c.plan.picks.length));
  for (const part of ['email', 'landing_page', 'catalog'] as const) {
    it(`${part}: clean render has no mismatch`, () => expect(mismatches(part, parts[part])).toEqual([]));
    it(`${part}: each link, swapped to another pick's handle, fails LINK_MISMATCH`, () => {
      const links = [...parts[part].matchAll(/<a\b[^>]*href="[^"]*\/products\/([^"]+)"[^>]*>/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        const other = c.plan.picks.map((p) => cat.rows.get(p.product_id)!.handle).find((h) => h !== link[1])!;
        const tag = link[0].replace(`/products/${link[1]}"`, `/products/${other}"`);
        const html = parts[part].slice(0, link.index) + tag + parts[part].slice(link.index + link[0].length);
        expect(mismatches(part, html), link[0]).toHaveLength(1);
      }
    });
  }
});

describe('eyebrow, code only', () => {
  it('first name and occasion', () => expect(landing('GOOD-c16').html).toContain("For Aditi · Mother&#39;s birthday"));
  it('blank name: occasion alone', () => {
    const { html } = landing('GOOD-c16', { display_name: null });
    expect(html).toContain('>Mother&#39;s birthday<');
    expect(html).not.toContain('For ');
  });
  it('occasion is file input: L-10 escaped, no element added', () => {
    const { html } = landing('GOOD-c16', { occasion: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('eyebrow from the envelope alone', () => {
  it('renderAll passes no plan today: the name still shows', () => {
    const c = fxCase('GOOD-c16');
    expect(renderLanding(expandLanding(c.model.landing_page!, c.envelope, cat), cat, c.envelope)).toContain('>For Aditi<');
  });
});

describe('test 7 structure: phone rules are in the page', () => {
  for (const id of ['GOOD-c16', 'GOOD-c07']) {
    it(`${id}: viewport, phone media query, hero is split not 16:9`, () => {
      const { html } = landing(id);
      expect(html).toContain('name="viewport"');
      expect(html).toMatch(/@media \(max-width: ?749px\)/);
      expect(html).not.toContain('16 / 9');
    });
  }
});

describe('test 8: open shape and c20 render', () => {
  const c = fxCase('GOOD-c20');
  const { html } = landing('GOOD-c20');
  it('fixture is the c20 row: no name, no occasion, open', () => {
    expect(c.plan).toMatchObject({ customer_id: 'c20', display_name: null, occasion: null, shape: 'open', new_user: true });
  });
  it('no eyebrow, no season line invented (O7)', () => {
    expect(body(html)).not.toContain('nb-eyebrow');
    expect(html).not.toMatch(/festive season/i);
  });
  it('renders hero and catalog with no eyebrow', () => {
    expect(html).toContain('nb-hero--split');
    expect(body(renderCatalog(c.plan, cat))).not.toContain('nb-eyebrow');
  });
});
