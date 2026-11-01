// What a clean clone needs: committed input, one command, nothing that points outside the repo.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import cap from '../../config/cap.json' with { type: 'json' };
import prices from '../../config/prices.json' with { type: 'json' };
import rungs from '../../config/rungs.json' with { type: 'json' };
import { admitAll } from '../../src/lib/cost/index.ts';
import type { CapConfig, Prices, Rung } from '../../src/contracts/types.ts';
import { parseBatchArgs, runId, wantsKey } from '../../scripts/batch.ts';
import { devArgs, stubCount } from '../../scripts/demo.ts';
import { startStub } from '../../scripts/stub-llm.ts';
import { liveRecs } from '../../scripts/readiness.ts';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('samples/site', () => {
  const manifest = JSON.parse(readFileSync('samples/site/urls.json', 'utf8')) as { files: { file: string; url: string; fetched_at: string; sha256: string }[] };
  it('every file has its source URL, fetch date and the hash of its bytes', () => {
    for (const f of manifest.files) {
      expect(f.url).toMatch(/^https:\/\/www\.nicobar\.com\//);
      expect(f.fetched_at).toMatch(/^\d{4}-\d\d-\d\d/);
      expect(createHash('sha256').update(readFileSync(join('samples/site', f.file))).digest('hex'), f.file).toBe(f.sha256);
    }
  });
  it('holds no image file', () => expect(walk('samples/site').filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f))).toEqual([]));
});

describe('no harness strings ship', () => {
  const files = ['src', 'scripts', 'config'].flatMap(walk).concat('wrangler.jsonc', 'package.json', 'data/recommendations.synthetic.json');
  const banned = [/46 ?§/, /\bLLD\b/, /\bHLD\b/, /handover/i, /\/Users\//, /\.agent\//, /\b(sift|quill|smith|tally|atlas|scout)\b/, /\bprobe \d/, /\bward \d/, /\blanes?\b/, /plan 42/, /brief \d/, /\bparent's\b/];
  it('none in src, scripts, config', () => {
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (banned.some((b) => b.test(l)) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });
  it('the check does fire', () => expect(banned.some((b) => b.test('see 46 §3'))).toBe(true));
});

describe('start rung', () => {
  it('is sonnet-default, the rung the cost plan assumes', () => expect(rungs[0]!.id).toBe('sonnet-default'));
});

describe('demo', () => {
  const r = rungs as unknown as Rung[];
  it('the stub count admits every customer under the real cap.json', () => {
    const est = (key: string) => ({ key, format: 'both' as const, rung: r[0]!.id, input_tokens: stubCount(9000, cap as unknown as CapConfig) });
    const a = admitAll(['a', 'b'].map(est), cap as unknown as CapConfig, r, r[0]!.id, null, prices as Prices);
    expect(a.admitted).toHaveLength(2);
  });
  it('without it the real cap skips them: why the count is needed', () => {
    const a = admitAll([{ key: 'a', format: 'both', rung: r[0]!.id, input_tokens: 12000 }], cap as unknown as CapConfig, r, r[0]!.id, null, prices as Prices);
    expect(a.per.a).toMatchObject({ action: 'skip', code: 'OVER_CAP' });
  });
  it('no key can reach the demo server: .dev.vars is off, the base URL is the stub', () => {
    const a = devArgs(8787, 8788, '/x/empty.env', 'throwaway').join(' ');
    expect(a).toContain('--env-file /x/empty.env');
    expect(a).toContain('RUN_KEY:throwaway');
    expect(a).toContain('ANTHROPIC_BASE_URL:http://127.0.0.1:8788');
    expect(a).toContain('ANTHROPIC_API_KEY:stub');
  });
});

describe('stub key guard', () => {
  const call = async (headers: Record<string, string>) => {
    const s = await startStub(0, { key: 'stub' }), { port } = s.address() as AddressInfo;
    try { return (await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, { method: 'POST', headers, body: '{}' })).status; } finally { s.close(); }
  };
  it('a demo stub refuses anything but the stub key, so a real key that leaked fails loud', async () => {
    expect(await call({ 'x-api-key': 'sk-real' })).toBe(401);
    expect(await call({ authorization: 'Bearer sk-real' })).toBe(401);
    expect(await call({ 'x-api-key': 'stub' })).toBe(200);
  });
  it('the SDK sends its key as a bearer token, and that passes', async () => {
    expect(await call({ authorization: 'Bearer stub' })).toBe(200);
  });
});

describe('readiness inputs', () => {
  const file = { snapshot_id: 'old', rows: [{ customer_id: 'c-ok-1', picks: [{ product_id: 'a' }, { product_id: 'b' }, { product_id: 'c' }, { product_id: 'd' }] },
    { customer_id: 'c-badpick', picks: [{ product_id: 'a' }, { product_id: 'b' }, { product_id: 'c' }, { product_id: 'back-in-stock' }] }] };
  const out = liveRecs(file, { snapshot_id: 'new', generated_by: { version: 'rank-v1' }, soldOut: 'gone' });
  it('carries the snapshot and versions the run route checks', () => {
    expect(out).toMatchObject({ snapshot_id: 'new', generated_by: { version: 'rank-v1' } });
  });
  it('c-badpick p4 is a product that is sold out on this snapshot, and nobody else changes', () => {
    expect(out.rows[1]!.picks.map((p: { product_id: string }) => p.product_id)).toEqual(['a', 'b', 'c', 'gone']);
    expect(out.rows[0]).toEqual(file.rows[0]);
  });
});

describe('batch', () => {
  it('parses stage and format, defaulting to both', () => {
    expect(parseBatchArgs(['--stage', 'F'])).toMatchObject({ stage: 'F', format: 'both' });
    expect(parseBatchArgs(['--stage', 'rehearsal', '--format', 'email'])).toMatchObject({ format: 'email' });
  });
  it('refuses an unknown stage or format, and no stage', () => {
    expect(() => parseBatchArgs([])).toThrow(/--stage/);
    expect(() => parseBatchArgs(['--stage', 'nope'])).toThrow(/stage/);
    expect(() => parseBatchArgs(['--stage', 'F', '--format', 'fax'])).toThrow(/format/);
  });
  it('a stub run carries the stub prefix, a real one does not', () => {
    expect(runId('F', 'x', 'http://127.0.0.1:1')).toBe('stub-F-x');
    expect(runId('F', 'x', undefined)).toBe('F-x');
  });
  it('a real run needs a key', () => {
    expect(wantsKey({})).toBe(true);
    expect(wantsKey({ ANTHROPIC_API_KEY: 'k' })).toBe(false);
    expect(wantsKey({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })).toBe(false);
  });
});
