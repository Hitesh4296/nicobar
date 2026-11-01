// The product read (R141), as JSON and as a page. Both GET over `search`, with no model: the filters are actual product finds.
import { CatalogMissing } from '../../contracts/codes.ts';
import { loadCatalog } from '../../lib/catalog/index.ts';
import { activeCatalog } from '../../lib/config/index.ts';
import { overridden, liveConfig, BASE_WEIGHTS } from '../../lib/rank/live.ts';
import { buildIndex, queryOfParams, readProducts } from '../../lib/search/index.ts';
import { sideFile, snapshotId } from './catalog.ts';
import { searchPage } from '../../ui/search.ts';
import type { Ctx, Route } from './list.ts';
import { inputs } from './refine.ts';

const MAX_ROWS = 60;

async function catalogOf(c: Ctx) {
  const files = c.env.DEPLOYED === '1' ? null : await inputs(c.env), id = await snapshotId(c.env, files?.recs ?? null);
  if (!id) throw new CatalogMissing();
  const { cat } = overridden(await loadCatalog(c.env, id), liveConfig('search', BASE_WEIGHTS), await activeCatalog(c.env.DB));
  return { id, index: buildIndex(cat.usable) };
}

async function page(c: Ctx): Promise<Response> {
  const { id, index } = await catalogOf(c), query = queryOfParams(new URL(c.req.url).searchParams), r = readProducts(query, index), detail = await sideFile(c.env, id);
  const rows = r.ids.slice(0, MAX_ROWS).map((i) => ({ ...index.products.get(i)!, tags: detail?.[i]?.tags ?? [] }));
  return new Response(searchPage({ query, count: r.count, counts: r.counts, rows }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const whole = (v: string | null, d: number, max: number) => { const n = Number(v ?? d); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : d; };

/** A read with no model, so it stays on the deployed link. */
async function products(c: Ctx): Promise<Response> {
  const { id, index } = await catalogOf(c), p = new URL(c.req.url).searchParams, limit = whole(p.get('limit'), MAX_ROWS, MAX_ROWS), offset = whole(p.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  const r = readProducts(queryOfParams(p), index);
  return Response.json({ snapshot_id: id, count: r.count, limit, offset, ids: r.ids, products: r.ids.slice(offset, offset + limit).map((i) => { const x = index.products.get(i)!; return { id: x.id, handle: x.handle, title: x.title, url: x.url, image: x.images[0]?.src_canonical ?? null, facets: x.facets ?? {} }; }), counts: r.counts });
}

export const routes: Route[] = [{ method: 'GET', path: '/review/search', handler: page }, { method: 'GET', path: '/api/products', handler: products }];
