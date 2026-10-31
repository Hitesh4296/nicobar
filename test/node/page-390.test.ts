// page lane test 7: a real 390 px render of c16 and c07. Needs agent-browser; layout does not depend on the images loading (width and height are on each tag).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandLanding, fxCase } from '../../scripts/seed.ts';
import { renderLanding } from '../../src/lib/render/landing-v2.ts';
import { fxCatalog } from '../fakes/index.ts';

const hasBrowser = spawnSync('agent-browser', ['--version']).status === 0;
const ab = (...args: string[]) => execFileSync('agent-browser', args, { encoding: 'utf8' });
const MEASURE = `JSON.stringify({ sw: document.documentElement.scrollWidth,
  tap: Math.min(...[...document.querySelectorAll('a.nb-link,a.nb-row')].map((a) => a.getBoundingClientRect().height)),
  hero: (() => { const r = document.querySelector('.nb-hero img').getBoundingClientRect(); return [r.left, r.width, Math.round(r.height)]; })(),
  feature: [...document.querySelectorAll('.nb-split')].map((s) => { const i = s.querySelector('img').getBoundingClientRect(); const t = s.querySelector('.nb-split-text').getBoundingClientRect(); return [i.left, i.width, i.top < t.top]; }),
  pair: [...document.querySelectorAll('.nb-duo')].map((d) => { const [a, b] = d.querySelectorAll('img'); return a.getBoundingClientRect().top === b.getBoundingClientRect().top; }) })`;

describe.skipIf(!hasBrowser)('test 7: 390 px', () => {
  for (const id of ['GOOD-c16', 'GOOD-c07']) {
    it(id, () => {
      const c = fxCase(id);
      const cat = fxCatalog();
      const file = join(mkdtempSync(join(tmpdir(), 'nb-')), `${id}.html`);
      writeFileSync(file, renderLanding(expandLanding(c.model.landing_page!, c.envelope, cat), cat, c.envelope, c.plan));
      ab('set', 'viewport', '390', '844');
      ab('open', `file://${file}`);
      const raw = ab('eval', MEASURE).trim();
      const m = JSON.parse(JSON.parse(raw)) as { sw: number; tap: number; hero: number[]; feature: [number, number, boolean][]; pair: boolean[] };
      expect(m.sw).toBeLessThanOrEqual(390);
      expect(m.tap).toBeGreaterThanOrEqual(44);
      expect(m.hero).toEqual([0, 390, 488]);     // stacked, full width, 4:5
      for (const f of m.feature) expect(f).toEqual([0, 390, true]);   // C7 phone: image first, then text
      for (const p of m.pair) expect(p).toBe(true);                   // pairing stays two across
    }, 30_000);
  }
});
