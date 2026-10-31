// lane gen: scripts/draft-one.ts, scripts/preview.ts on the real stub, fake Lib. No key, $0.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prices from '../../config/prices.json' with { type: 'json' };
import rungs from '../../config/rungs.json' with { type: 'json' };
import cap from '../../config/cap.json' with { type: 'json' };
import { draftOne, makeClient, parseCli, sha256Hex, type Deps } from '../../scripts/draft-one.ts';
import { preview } from '../../scripts/preview.ts';
import { readPromptDir } from '../../scripts/prompt-dir.ts';
import { canonicalContent } from '../../src/lib/gen/canonical.ts';
import { startStub } from '../../scripts/stub-llm.ts';
import type { CapConfig, Prices, Rung } from '../../src/contracts/types.ts';
import { fakeLib, fxCatalog } from '../fakes/index.ts';

const prompt = readPromptDir('config/prompt/v1');
let close: () => void;
let baseURL: string;
beforeAll(async () => {
  const s = await startStub();
  close = () => s.close();
  baseURL = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
});
afterAll(() => close());

function deps(extra: Partial<Deps> = {}) {
  const logs: Record<string, unknown>[] = [];
  const d: Deps = { lib: fakeLib, client: makeClient({ ANTHROPIC_BASE_URL: baseURL }), cap: cap as unknown as CapConfig, prices: prices as Prices,
    rungs: rungs as unknown as Rung[], inputs: { customers: 'x', recs: '{"rows":[]}', keys: '{}', shapes: '{"version":"x","default":"open","shapes":[]}', cat: fxCatalog() },
    log: (l) => logs.push(l), ...extra };
  return { d, logs };
}
const opts = (o: Record<string, unknown> = {}) => ({ limitUsd: 5, prompt, promptId: 'v1', label: 't', format: 'both' as const,
  outDir: mkdtempSync(join(tmpdir(), 'voice-')), ...o });

describe('6 preview, no key', () => {
  it('runs on the stub count_tokens with no key in the environment', async () => {
    const puts: [string, string][] = [];
    const { d } = deps();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const r = await preview({ prompt, promptId: 'v1', format: 'both' }, { ...d, put: async (k, v) => { puts.push([k, v]); } });
    expect(Object.keys(r.body.plans[0].admission ?? {})).toContain('input_tokens');
    expect(r.body.plans[0].admission!.input_tokens).toBeGreaterThan(1000);
    expect(puts[0][0]).toBe(`previews/${r.sha256}.json`);
  });
});

describe('6c preview writes prompt_sha256', () => {
  it('is the sha256 of canonicalContent, with the other pins', async () => {
    const puts: string[] = [];
    const { d } = deps();
    const r = await preview({ prompt, promptId: 'v1', format: 'both' }, { ...d, put: async (_k, v) => { puts.push(v); } });
    expect(r.body.prompt_sha256).toBe(sha256Hex(canonicalContent(prompt)));
    expect(r.body.prompt_version).toBe('v1');
    expect(r.body.cap_sha256).toBe(sha256Hex(JSON.stringify(cap)));
    const edited = await preview({ prompt, promptId: 'v1', format: 'both' }, { ...deps({ cap: { ...cap, S: { ...cap.S, both: cap.S.both + 1 } } as unknown as CapConfig }).d, put: async () => {} });
    expect(edited.body.cap_sha256).not.toBe(r.body.cap_sha256);
    expect(r.body.start_rung).toBe(rungs[0].id);
    expect(JSON.parse(puts[0]).prompt_sha256).toBe(r.body.prompt_sha256);
    expect(sha256Hex(puts[0])).toBe(r.sha256);
  });
  it('a failed plan is kept and not estimated; a failed estimate reaches admitAll as missing', async () => {
    const { d } = deps();
    let seen: string[] = [];
    const lib = { ...fakeLib, admitAll: ((e, ...rest) => { seen = e.map((x) => x.key); return fakeLib.admitAll(e, ...rest); }) as typeof fakeLib.admitAll };
    const client = { messages: { countTokens: async () => { throw new Error('boom'); } } } as unknown as Deps['client'];
    const r = await preview({ prompt, promptId: 'v1', format: 'both' }, { ...d, lib, client, put: async () => {} });
    expect(seen).toEqual([]);
    expect(r.body.plans.map((p) => p.customer_id)).toContain('row:3');
  });
});

describe('6a draft-one --limit-usd', () => {
  it('stops and logs before the call that passes it, and makes no such call', async () => {
    const { d, logs } = deps();
    const calls: unknown[] = [];
    const client = d.client;
    const orig = client.messages.create.bind(client.messages);
    client.messages.create = ((b: unknown) => { calls.push(b); return orig(b as never); }) as typeof client.messages.create;
    const lib = { ...fakeLib, callWorst: () => 0.04 };
    const o = opts({ limitUsd: 0.05 });
    const r = await draftOne(o, { ...d, lib });
    expect(r.stopped).toBe(true);
    expect(calls.length).toBe(r.written.length);
    expect(r.spent_usd + 0.04).toBeGreaterThan(0.05);
    const stop = logs.find((l) => l.status === 'stopped')!;
    expect(stop).toMatchObject({ step: 'limit', code: 'LIMIT', est_usd: 0.04, limit_usd: 0.05 });
    expect(logs.at(-1)).toBe(stop);
  });
  it('a first call over the limit is never made', async () => {
    const { d, logs } = deps();
    const client = { messages: { countTokens: async () => ({ input_tokens: 10 }), create: async () => { throw new Error('called'); } } } as unknown as Deps['client'];
    const r = await draftOne(opts({ limitUsd: 0.01 }), { ...d, client, lib: { ...fakeLib, callWorst: () => 0.02 } });
    expect(r).toMatchObject({ stopped: true, written: [], spent_usd: 0 });
    expect(logs.some((l) => l.code === 'LIMIT')).toBe(true);
  });
  it('a call that dies is counted at its worst, since it may have billed', async () => {
    const { d, logs } = deps();
    const client = { messages: { countTokens: async () => ({ input_tokens: 10 }), create: async () => { throw new Error('timeout'); } } } as unknown as Deps['client'];
    const r = await draftOne(opts({ limitUsd: 0.25, only: 'fx-both' }), { ...d, client, lib: { ...fakeLib, callWorst: () => 0.1 } });
    expect(r.spent_usd).toBe(0.1);
    expect(logs.some((l) => l.status === 'possibly_billed')).toBe(true);
  });
  it('--limit-usd is required and must be positive', () => {
    expect(() => parseCli([])).toThrow(/limit-usd/);
    expect(() => parseCli(['--limit-usd', '0'])).toThrow(/limit-usd/);
    expect(() => parseCli(['--limit-usd', 'abc'])).toThrow(/limit-usd/);
  });
});

describe('6b --prompt-dir and --only', () => {
  it('parses both, and the label defaults to the prompt dir name', () => {
    expect(parseCli(['--limit-usd', '0.10', '--prompt-dir', 'out/prompt/v7/', '--only', 'c03'])).toMatchObject(
      { limitUsd: 0.1, promptDir: 'out/prompt/v7/', promptId: 'v7', label: 'v7', only: 'c03', format: 'both' });
  });
  it('--only runs one customer, and writes 46 §1 voice output without a render', async () => {
    const { d, logs } = deps();
    const o = opts({ only: 'fx-email' });
    const r = await draftOne(o, d);
    expect(r.written).toEqual([join(o.outDir, 't', 'fx-email.json')]);
    const j = JSON.parse(readFileSync(r.written[0], 'utf8'));
    expect(Object.keys(j)).toEqual(['plan', 'envelope', 'request_sha256', 'message', 'model_json', 'checks']);
    expect(j.envelope).toMatchObject({ customer_id: 'fx-email', format: 'email', setting: rungs[0].id, prompt_version: 'v1', voice_guide_version: 'v1',
      carried_from: null, carried_part: null, snapshot_id: fxCatalog().snapshot_id });
    expect(j.plan.run_id).toBe('voice-t');
    expect(j.model_json.email.subject).toBeTruthy();
    expect(j.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(logs)).not.toContain('Fixture');
  });
  it('--only with an unknown id does nothing and says so', async () => {
    const { d, logs } = deps();
    const r = await draftOne(opts({ only: 'zz' }), d);
    expect(r.written).toEqual([]);
    expect(logs[0]).toMatchObject({ key: 'zz', code: 'NOT_IN_INPUT' });
  });
  it('a failed plan makes no call and does not stop the others', async () => {
    const { d, logs } = deps();
    const r = await draftOne(opts(), { ...d, lib: { ...fakeLib, validate: () => [] } });
    expect(logs.find((l) => l.key === 'row:3')).toMatchObject({ status: 'failed', code: 'INVALID_CUSTOMER' });
    expect(r.written.length).toBeGreaterThan(1);
    expect(r.written.some((f) => f.endsWith('row:3.json'))).toBe(false);
  });
  it('a paid answer is kept on disk even if validate throws', async () => {
    const { d } = deps();
    const r = await draftOne(opts({ only: 'fx-both' }), { ...d, lib: { ...fakeLib, validate: () => { throw new Error('NOT_BUILT'); } } });
    expect(existsSync(r.written[0])).toBe(true);
    expect(JSON.parse(readFileSync(r.written[0], 'utf8')).checks).toBeNull();
  });
  it('a refusal is stored, unparsed, and not a crash', async () => {
    const { d } = deps();
    const lib = { ...fakeLib, planCustomer: ((...a) => ({ ...fakeLib.planCustomer(...a), occasion: 'fx-refuse' })) as typeof fakeLib.planCustomer };
    const r = await draftOne(opts({ only: 'fx-both' }), { ...d, lib });
    const j = JSON.parse(readFileSync(r.written[0], 'utf8'));
    expect(j.message.stop_reason).toBe('refusal');
    expect(j.model_json).toEqual({ unparsed: '' });
  });
});
