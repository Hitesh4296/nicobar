import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../src/contracts/types.ts';
import { imageGate, PROSE, validate, validateRendered } from '../../src/lib/check/index.ts';
import { evalCatalog, planFor, runMutants, runSuite } from '../../scripts/eval.ts';

const load = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const CASES = ['checks', 'blind-drafts', 'layout'].flatMap((f) => load(`test/cases/${f}.json`).cases);
const cat = evalCatalog();
const byId = (id: string) => CASES.find((c: any) => c.id === id);
const failed = (rs: CheckResult[]) => rs.filter((r) => !r.pass && r.severity === 'hard').map((r) => r.id);
function run(id: string, edit?: (c: any) => void) {
  const c = structuredClone(byId(id));
  edit?.(c);
  const { plan, envelope } = planFor(c, cat);
  return validate(JSON.stringify(c.draft), envelope, cat, plan);
}
const failedDetail = (rs: CheckResult[], id: string) => rs.filter((r) => r.id === id && !r.pass).map((r) => r.detail);
const good = 'G1';
const addBody = (t: string) => (c: any) => { c.draft.email.body += ` ${t}`; };

describe('test 1: the four named failures', () => {
  it('a made-up product fails', () => {
    expect(failed(run('BL-D3'))).toContain('C8d');
    expect(failed(run('R18-1'))).toContain('C8d-x');
    expect(failed(run('L-03'))).toContain('C8');
  });
  it('an image not on nicobar.com fails', () => {
    const { plan, envelope } = planFor(byId(good), cat);
    const page = (src: string) => ({ email: `<a data-slot="p1" href="${cat.rows.get(plan.picks[0].product_id)!.url}"><img data-slot="p1" src="${src}" alt="t"></a>`, landing_page: null, catalog: '' });
    expect(failed(validateRendered(page('https://images.example.com/a.jpg'), envelope, cat, plan))).toContain('X2');
  });
  it('a discount phrase fails', () => expect(failed(run(good, addBody('It is 20% off this week.')))).toContain('C4'));
  it('121 words fail, 120 pass', () => {
    expect(failed(run('N-11'))).toContain('C3.L');
    expect(failed(run('N-12'))).toEqual([]);
    expect(failed(run('N7-1'))).toContain('C3');
  });
});

describe('the rules the suite must hold', () => {
  it('test 2: C8n on past items', () => expect(failed(run('L-04'))).toContain('C8n'));
  it('test 3: C4 familiarity, and bare again passes', () => {
    expect(failed(run('N-04-1'))).toContain('C4');
    expect(failed(run('N-04-7'))).toEqual([]);
  });
  it('test 4: C7 slot scope: a note on p1 naming p2 material fails, on p2 it passes', () => {
    expect(failed(run('N-03a'))).toContain('C7');
    expect(failed(run('N-03b'))).toEqual([]);
  });
  it('test 5: C8o on a none row, not on a row with an occasion', () => {
    expect(failed(run('N-09a'))).toContain('C8o');
    expect(failed(run('N-09b'))).toContain('C8o');
    expect(failed(run('N-09c'))).toEqual([]);
  });
  it('test 6: C6 passes null, a string against a null key fails', () => {
    expect(failed(run('N-02a'))).toEqual([]);
    expect(failed(run('N-02c'))).toContain('C6');
    expect(failed(run('N-02d'))).toContain('C6');
  });
  it('test 6a: a missing part or a stray key fails C1 and stops', () => {
    for (const id of ['N-07a', 'N-07b', 'N-07c', 'N-07d', 'N-07e', 'N-07f']) expect(new Set(failed(run(id))), id).toEqual(new Set(['C1']));
  });
  it('stamps every part, carried parts included', () => {
    const parts = new Set(run('GOOD-c20-both').map((r) => r.part));
    expect(parts).toEqual(new Set(['email', 'landing_page']));
  });
  it('a check that throws is a failure, not a crash', () => {
    const c = structuredClone(byId(good));
    const { plan, envelope } = planFor(c, cat);
    plan.picks[0] = { ...plan.picks[0], product_id: 'gone' };
    const rs = validate(JSON.stringify(c.draft), envelope, cat, plan);
    expect(rs.filter((r) => r.code === 'CHECK_ERROR').length).toBeGreaterThan(0);
  });
});

describe('test 7: X1 to X4 on the rendered page', () => {
  const c = byId('GOOD-c18');
  const { plan, envelope } = planFor(c, cat);
  const pick = (s: number) => cat.rows.get(plan.picks[s].product_id)!;
  const card = (s: number, over: { src?: string; href?: string; alt?: string } = {}) => {
    const p = pick(s), slot = `p${s + 1}`;
    return `<a data-slot="${slot}" href="${over.href ?? p.url}"><img data-slot="${slot}" src="${over.src ?? p.images[0].src}" alt="${over.alt ?? p.title.replace(/&/g, '&amp;')}"></a>`;
  };
  const page = (over: { src?: string; href?: string; alt?: string } = {}) => {
    const html = [card(0, over), card(1), card(2), card(3)].join('');
    return { email: null, landing_page: html, catalog: [card(0), card(1), card(2), card(3)].join('') };
  };
  const x = (r: ReturnType<typeof page>) => failed(validateRendered(r, envelope, cat, plan));
  it('a clean page passes', () => expect(x(page())).toEqual([]));
  it('X1: p1 shows p2 image', () => expect(x(page({ src: pick(1).images[0].src }))).toContain('X1'));
  it('X1: a slot left off the page', () => expect(x({ ...page(), landing_page: card(0) })).toContain('X1'));
  it('X1: envelope picks differ from the plan', () => {
    const env = { ...envelope, picks: [...envelope.picks].reverse() };
    expect(failed(validateRendered(page(), env, cat, plan))).toContain('X1');
  });
  it('X2: an off-site image', () => expect(x(page({ src: 'https://i.ibb.co/x.jpg' }))).toContain('X2'));
  it('X3: a look-alike link', () => expect(x(page({ href: 'https://www.nicobar.com.evil.io/products/x' }))).toContain('X3'));
  it('X4: an empty alt', () => expect(x(page({ alt: '' }))).toContain('X4'));
  it('X2 reasons match the gate cases', () => {
    const gate = load('test/cases/image-gate-and-links.json').cases.filter((k: any) => typeof k.url === 'string');
    const picks = load('test/cases/picks.json').picks;
    for (const k of gate) {
      const selected = k.selected.map((h: string) => cat.rows.get(picks[h].id)!);
      expect(imageGate(k.url, selected), k.id).toBe(k.reference_reason);
    }
  });
});

describe('C8 against the rules data builds', () => {
  it('a Title-Case phrase ending in a plural class noun fails, nouns being stems', () => {
    expect(cat.rules.nouns).toContain('bangl');
    const c8 = failedDetail(run(good, addBody('It sits with the Quiet Bangles.')), 'C8');
    expect(c8).toContain('Quiet Bangles');
  });
});

describe('L-11: every string leaf of the schemas is registered', () => {
  const leaves = (schema: any, path: string, out: string[]) => {
    if (schema.anyOf || schema.$ref) return out;
    if (schema.oneOf) { for (const s of schema.oneOf) leaves(s, `${path}[${s.properties.type.const}]`, out); return out; }
    if (schema.type === 'array') return leaves(schema.items, `${path}[]`, out);
    if (schema.type === 'object') { for (const [k, v] of Object.entries<any>(schema.properties)) leaves(v, path ? `${path}.${k}` : k, out); return out; }
    if (schema.type === 'string') out.push(path);
    return out;
  };
  const clean = (l: string) => l.replace('sections[][', 'sections[');
  const nonProse = ['occasion_key', 'type', 'slot', 'slots[]', 'quote_id'];
  for (const [part, file] of [['email', 'draft-email.v2'], ['landing_page', 'draft-landing.v3']] as const) {
    it(`${part} has no unscanned prose`, () => {
      const found = leaves(load(`config/schemas/${file}.json`), '', []).map(clean)
        .filter((l) => !nonProse.includes(l.split('.').at(-1)!));
      expect(found.sort()).toEqual([...PROSE[part]].sort());
    });
  }
});

describe('test 8: every case and mutant', () => {
  it('no case misses and no mutant survives', async () => {
    const out = runSuite(cat);
    expect(out.filter((o) => !o.ok).map((o) => `${o.file}:${o.id} ${o.why}`)).toEqual([]);
    expect(out.length).toBeGreaterThanOrEqual(171);
    const mutants = await runMutants(cat, out);
    expect(mutants).toHaveLength(22);
    expect(mutants.filter((m) => !m.killed).map((m) => m.id)).toEqual([]);
  }, 300_000);
});
