import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from '../fixtures/catalog.fixture.json' with { type: 'json' };
import { loadCatalog } from '../../src/lib/catalog/index.ts';
import type { AppEnv } from '../../src/contracts/types.ts';

const e = env as unknown as AppEnv;
const rules = { title_cores: ['A B'], distinctive_cores: [], nouns: ['mug'], handles: ['h'] };
const put = async (id: string) => {
  await e.BUCKET.put(`snapshots/${id}/catalog.json`, JSON.stringify({ snapshot_id: id, fetched_at: fixture.fetched_at, rows: fixture.rows }));
  await e.BUCKET.put(`snapshots/${id}/rules.json`, JSON.stringify(rules));
};

describe('loadCatalog', () => {
  beforeAll(async () => { for (const id of ['a', 'b', 'c']) await put(id); });
  it('reads catalog and rules from R2 into the Catalog shape', async () => {
    const c = await loadCatalog(e, 'a');
    expect(c.snapshot_id).toBe('a');
    expect(c.rows.size).toBe(50);
    expect(c.usable).toHaveLength(50);
    expect(c.by_sku.get(c.usable[0].variants[0].sku!)).toBe(c.usable[0].id);
    expect(c.rules).toEqual(rules);
  });
  it('keeps the pinned and the newest per isolate, and no more', async () => {
    const a = await loadCatalog(e, 'a');
    const b = await loadCatalog(e, 'b');
    expect(await loadCatalog(e, 'a')).toBe(a);
    expect(await loadCatalog(e, 'b')).toBe(b);
    await loadCatalog(e, 'c');
    expect(await loadCatalog(e, 'a')).not.toBe(a);
  });
  it('throws on a snapshot that is not in R2', async () => {
    await expect(loadCatalog(e, 'missing')).rejects.toThrow(/missing/);
  });
});
