import type { AppEnv, Catalog, Product, Rules } from '../../contracts/types.ts';

export interface CatalogFile { snapshot_id: string; fetched_at: string; rows: Product[] }

export function toCatalog(f: CatalogFile, rules: Rules): Catalog {
  return { snapshot_id: f.snapshot_id, fetched_at: f.fetched_at, rules, rows: new Map(f.rows.map((p) => [p.id, p])),
    by_sku: new Map(f.rows.flatMap((p) => p.variants.flatMap((v) => (v.sku ? [[v.sku, p.id] as [string, string]] : [])))),
    usable: f.rows.filter((p) => p.excluded_reason === null) };
}

async function readJson<T>(env: AppEnv, key: string): Promise<T> {
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error(`not in R2: ${key}`);
  return obj.json<T>();
}

// Resolved values only: a promise from another request cannot be awaited in a Worker. Two, because E7 needs the pinned and the newest (LLD).
const cache = new Map<string, Catalog>();

export async function loadCatalog(env: AppEnv, snapshot_id: string): Promise<Catalog> {
  const hit = cache.get(snapshot_id);
  if (hit) return hit;
  const [f, rules] = await Promise.all([readJson<CatalogFile>(env, `snapshots/${snapshot_id}/catalog.json`),
    readJson<Rules>(env, `snapshots/${snapshot_id}/rules.json`)]);
  const cat = toCatalog(f, rules);
  cache.set(snapshot_id, cat);
  if (cache.size > 2) cache.delete(cache.keys().next().value!);
  return cat;
}
