// npm run collections -- <dir>: reduces cached /collections/<handle>/products.json pages (col-<handle>-<page>.json) to samples/site/collections.json, the order only. Fetches nothing. Rerun as pages arrive.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: npm run collections -- <dir>');
const pages = readdirSync(dir).flatMap((f) => { const m = f.match(/^col-(.+)-(\d+)\.json$/); return m ? [{ f, handle: m[1], page: Number(m[2]) }] : []; }).sort((a, b) => a.page - b.page);
const collections: Record<string, string[]> = {};
for (const { f, handle } of pages) {
  const ids = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { products: { id: number }[] }).products.map((p) => String(p.id));
  collections[handle] = [...new Set([...(collections[handle] ?? []), ...ids])];
}
const file = { source: 'https://www.nicobar.com/collections/<handle>/products.json', fetched: '2026-11-01', note: 'Product ids in the site order, one list per collection. Order only: titles and copy stay in catalog.json.', collections };
writeFileSync('samples/site/collections.json', JSON.stringify(file));
console.log(Object.entries(collections).map(([h, v]) => `${h} ${v.length}`).join(', '));
