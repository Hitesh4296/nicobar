// scripts/judge.ts on a fake client: nothing here reaches a model.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import jev from '../../config/jev.json' with { type: 'json' };
import prices from '../../config/prices.json' with { type: 'json' };
import { buildJudgeRequest, judgeAll, type Item, type JudgeDeps } from '../../scripts/judge.ts';
import type { J3Input, JevConfig, Prices } from '../../src/contracts/types.ts';

const cfg = jev as unknown as JevConfig;
const input: J3Input = { email: 'A matching pair of drop earrings completes the set.', landing_page: null, quote: null, picks: [{ title: 'Noorani Necklace', facets: [] }], occasion: 'Dinner', occasion_key: 'dinner', new_user: false };
const item = (id = 'H-03'): Item => ({ id, source: 'heldout', customer: 'c03', occasion: 'Dinner', input });
const answers = (over: Record<string, unknown> = {}) => Object.fromEntries(Object.keys(cfg.j3).map((q) => [q, { flag: false, quote: '', why: 'Fine.', ...(over[q] as object) }]));
const message = (json: unknown, stop_reason = 'end_turn') => ({ content: [{ type: 'text', text: JSON.stringify(json) }], stop_reason, usage: { input_tokens: 1000, output_tokens: 500 } });

function deps(create: () => unknown, tokens = 1000) {
  const calls: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const d: JudgeDeps = { client: { messages: { countTokens: async () => ({ input_tokens: tokens }), create: async (r: unknown) => { calls.push(r); return create(); } } } as never,
    jev: async () => ({ status: 'answered', reason: null, model: cfg.model, answers: { discount: { type: 'noul', noul: 0.9 }, specific: { type: 'score', score: 3 } }, input_tokens: 2000, charged_usd: 0.0001, basis_usd: 0.0005 }),
    cfg, prices: prices as Prices, log: (l) => logs.push(l) };
  return { d, calls, logs };
}
const opts = (limitUsd = 1) => { const dir = mkdtempSync(join(tmpdir(), 'judge-')); return { limitUsd, outDir: dir, file: join(dir, 'judges.json') }; };

describe('the request', () => {
  it('Sonnet, the same j3 wording, the same input, no plant label', () => {
    const r = buildJudgeRequest(input, cfg) as any;
    expect(r.model).toBe('claude-sonnet-5-5');
    for (const q of Object.values(cfg.j3)) expect(JSON.stringify(r.system)).toContain(JSON.stringify(q.instructions).slice(1, -1));
    expect(r.messages[0].content).toBe(JSON.stringify(input));
    expect(Object.keys(r.output_config.format.schema.properties)).toEqual(Object.keys(cfg.j3));
  });
});

describe('quote', () => {
  it('a quote in the text stands', async () => {
    const o = opts();
    await judgeAll([item()], o, deps(() => message(answers({ names_unselected_product: { flag: true, quote: 'drop earrings', why: 'Not a pick.' } }))).d);
    const a = JSON.parse(readFileSync(o.file, 'utf8')).cases[0].sonnet.answers.names_unselected_product;
    expect(a).toEqual({ flag: true, quote: 'drop earrings', why: 'Not a pick.', quote_invalid: false });
  });
  it('a quote not in the text is recorded quote_invalid by code', async () => {
    const o = opts();
    await judgeAll([item()], o, deps(() => message(answers({ discount: { flag: true, quote: 'twenty percent off', why: 'x' } }))).d);
    expect(JSON.parse(readFileSync(o.file, 'utf8')).cases[0].sonnet.answers.discount.quote_invalid).toBe(true);
  });
  it('a flag with no quote is invalid too; no flag needs none', async () => {
    const o = opts();
    await judgeAll([item()], o, deps(() => message(answers({ pressure: { flag: true, quote: '', why: 'x' } }))).d);
    const a = JSON.parse(readFileSync(o.file, 'utf8')).cases[0].sonnet.answers;
    expect(a.pressure.quote_invalid).toBe(true);
    expect(a.discount.quote_invalid).toBe(false);
  });
});

describe('limit', () => {
  it('stops before the call when the estimate is over, logs it, and pays nothing', async () => {
    const { d, calls, logs } = deps(() => message(answers()), 100000);
    const r = await judgeAll([item()], opts(0.01), d);
    expect(r).toMatchObject({ stopped: true, spent_usd: 0 });
    expect(calls).toHaveLength(0);
    expect(logs[0]).toMatchObject({ step: 'limit', status: 'stopped', code: 'LIMIT' });
  });
  it('stops part way, keeping what it paid for, and a rerun does not pay twice', async () => {
    const o = opts(0.03);
    const first = deps(() => message(answers()));
    const r = await judgeAll([item('a'), item('b'), item('c')], o, first.d);
    expect(r.stopped).toBe(true);
    const done = JSON.parse(readFileSync(o.file, 'utf8')).cases.length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(3);
    const again = deps(() => message(answers()));
    await judgeAll([item('a'), item('b'), item('c')], { ...o, limitUsd: 1 }, again.d);
    expect(again.calls).toHaveLength(3 - done);
  });
});

describe('what comes back', () => {
  it('both judges saw the same input, flags and scores recorded, raw output on disk first', async () => {
    const o = opts();
    const { d } = deps(() => message(answers()));
    let seen: unknown;
    d.jev = async (i) => { seen = i; return { status: 'answered', reason: null, model: cfg.model, answers: { discount: { type: 'noul', noul: 0.9 }, specific: { type: 'score', score: 3 } }, input_tokens: 1, charged_usd: 0.0001, basis_usd: 0 }; };
    await judgeAll([item()], o, d);
    expect(seen).toBe(input);
    const c = JSON.parse(readFileSync(o.file, 'utf8')).cases[0];
    expect(c.jev.flags).toEqual(['discount']);
    expect(c.jev.scores).toEqual({ discount: 0.9, specific: 3 });
    expect(c.text).toBe(input.email);
    expect(c.cost.sonnet_usd).toBeCloseTo(0.007, 6);
    expect(JSON.parse(readFileSync(join(o.outDir, 'H-03.json'), 'utf8')).message.stop_reason).toBe('end_turn');
  });
  it('a refusal or a bad answer is a status, never a pass', async () => {
    const o = opts();
    await judgeAll([item('r'), item('x')], o, deps(() => message('not the shape', 'refusal')).d);
    expect(JSON.parse(readFileSync(o.file, 'utf8')).cases.map((c: any) => c.sonnet.status)).toEqual(['refused', 'refused']);
    const p = opts();
    await judgeAll([item()], p, deps(() => message({ nope: 1 })).d);
    expect(JSON.parse(readFileSync(p.file, 'utf8')).cases[0].sonnet).toMatchObject({ status: 'bad_output', answers: null });
  });
});
