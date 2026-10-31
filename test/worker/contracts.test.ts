import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import email from '../../config/schemas/draft-email.v2.json' with { type: 'json' };
import landing from '../../config/schemas/draft-landing.v3.json' with { type: 'json' };
import good from '../fixtures/drafts.good.json' with { type: 'json' };
import { contentSha256, lib } from '../../src/contracts/lib.ts';
import { imagePaths, renderAll } from '../../src/lib/render/index.ts';
import { NotBuilt } from '../../src/contracts/codes.ts';
import { LISTS } from '../../src/contracts/lists.ts';
import { FX_KEYS, fakeLib, fxCatalog, fxDraftStates, fxEnvelope, fxModelJson, fxPlan, fxReport } from '../fakes/index.ts';

describe('schema validator runs on Workers', () => {
  it('passes a staged email, refuses a broken one', () => {
    const v = new Validator(email as never, '2020-12', false);
    for (const d of good.drafts) if ('email' in d.draft) expect(v.validate(d.draft.email).valid, d.id).toBe(true);
    expect(v.validate({ subject: 'x' }).valid).toBe(false);
  });
  it('compiles landing v3 with $defs', () => {
    const v = new Validator(landing as never, '2020-12', false);
    for (const d of good.drafts) if ('landing_page' in d.draft) expect(v.validate(d.draft.landing_page).valid, d.id).toBe(true);
    expect(v.validate({ occasion_key: null, sections: [] }).valid).toBe(false);
  });
});

describe('contract helpers', () => {
  it('contentSha256 joins with NUL, so field boundaries count', async () => {
    expect(await contentSha256('ab', 'c', 'd')).not.toBe(await contentSha256('a', 'bc', 'd'));
    expect(await contentSha256('', '', '')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('imagePaths reads data-slot, strips host and query, first sighting wins', () => {
    expect(imagePaths({ email: '<img src="https://cdn.shopify.com/s/a.jpg?v=1" data-slot="p1"><img src="https://cdn.shopify.com/z.jpg">',
      landing_page: '<img data-slot="p1" src="https://cdn.shopify.com/s/b.jpg"><img data-slot="p2" src="https://cdn.shopify.com/s/c.jpg">', catalog: '' }))
      .toEqual({ p1: '/s/a.jpg', p2: '/s/c.jpg' });
  });
  it('lists compile', () => expect(Object.keys(LISTS)).toContain('c4'));
});

describe('fakes', () => {
  it('cover every lib signature', () => expect(Object.keys(fakeLib).sort()).toEqual(Object.keys(lib).sort()));
  it('stubs throw NOT_BUILT', () => expect(() => lib.ingestTsv('')).toThrow(NotBuilt));
  it('each key plans', () => {
    for (const k of FX_KEYS) expect(fxPlan(k).customer_id).toBe(k);
    expect(fxPlan('row:3').outcome).toEqual({ kind: 'failed', code: 'INVALID_CUSTOMER' });
    expect(fxPlan('fx-newuser').signals).toEqual(['occasion', 'season_prior']);
    expect(() => fxPlan('nobody')).toThrow();
  });
  it('fx-both renders through the fake with real pick slots', () => {
    const r = fakeLib.renderAll(fxModelJson('fx-both'), fxPlan('fx-both'), fxEnvelope('fx-both'), fxCatalog());
    expect(r.email && r.landing_page && r.catalog).toBeTruthy();
    expect(imagePaths(r).p1).toBe('/fx/p1.jpg');
  });
  it('fx-retry fails then passes; fx-throw throws', async () => {
    const hard = (n: 1 | 2) => fakeLib.validate('{}', fxEnvelope('fx-retry', n), fxCatalog(), fxPlan('fx-retry')).filter((c) => !c.pass).length;
    expect([hard(1), hard(2)]).toEqual([1, 0]);
    expect(await fakeLib.finish({} as never, 'r', 'fx-retry', 1)).toEqual({ retry: true });
    await expect(fakeLib.finish({} as never, 'r', 'fx-throw', 1)).rejects.toThrow();
  });
  it('fake transition refuses release on in_review', async () => {
    fxDraftStates.clear();
    const actor = { kind: 'dev', email: 'a', sub: 'dev:a' } as const;
    expect(await fakeLib.transition({} as never, 'd', 'E7', actor)).toMatchObject({ ok: false, code: 'WRONG_STATE' });
    expect(await fakeLib.transition({} as never, 'd', 'E4', actor)).toEqual({ ok: true, status: 'approved' });
    expect(await fakeLib.transition({} as never, 'd', 'E7', actor)).toEqual({ ok: true, status: 'released' });
  });
  it('fxReport has the run id', () => expect(fxReport('z').run_id).toBe('z'));
});
