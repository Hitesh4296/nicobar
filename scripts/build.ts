// Builds the snapshot from samples/site, the frozen copy of the site (R99: nothing is fetched). `--publish` writes the local D1 row and local R2 files, nothing remote.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapJson from '../config/occasion_map.json' with { type: 'json' };
import priorJson from '../config/prior_tags.json' with { type: 'json' };
import season from '../config/season.json' with { type: 'json' };
import { passesC0, passesC4, passesC5, stem, stripBody } from '../src/lib/catalog/strip.ts';
import type { CatalogFile } from '../src/lib/catalog/index.ts';
import { ingestTsv } from '../src/lib/ingest.ts';
import { countKeys } from '../src/lib/plan.ts';
import { parseRowKeys } from '../src/lib/recs.ts';
import type { MapRow, OccasionMap, Product, Rules } from '../src/contracts/types.ts';

interface Raw { id: number; title: string; handle: string; body_html: string | null; product_type: string; tags: string[];
  variants: { id: number; sku: string | null; title: string; option1: string | null; option2: string | null; price: string; available: boolean }[];
  images: { src: string; position: number; variant_ids: number[] }[]; options: { name: string; values: string[] }[] }

const map = mapJson as unknown as OccasionMap;
const PRIOR = new Set(priorJson.tags);
const FAMILIES = Object.keys(map.values);
const IMAGE_PREFIX = 'https://cdn.shopify.com/s/files/1/0270/5129/4854/';

const vals = (tags: string[], ...pre: string[]) => [...new Set(tags.flatMap((t) => { const p = pre.find((x) => t.startsWith(x)); return p ? [t.slice(p.length).trim()] : []; }))];
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const tagText = (h: string | null) => (h ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const isGiftCard = (p: Raw) => p.product_type === 'Gift Card' || p.tags.some((t) => t.toLowerCase() === 'giftcard');

function gender(tags: string[]): Product['gender'] {
  const g = vals(tags, 'Gender_')[0]?.toLowerCase();
  return g === 'female' || g === 'male' ? g : g === 'unisex' ? 'any' : null;
}

/** First failing rule of the usable filter; rule 1 (gift cards) never reaches here. Rule 8 reads season.json. */
function excluded(p: Raw, subcategory: string[], clean: string | null): string | null {
  if (!p.variants.some((v) => v.available)) return 'NOT_AVAILABLE';
  if (!clean) return 'NO_BODY';
  if (!p.images.length) return 'NO_IMAGE';
  if (!p.tags.some((t) => t.startsWith('Filtercategory_'))) return 'NO_CATEGORY';
  if (p.tags.some((t) => t.toLowerCase().startsWith('pfs:hidden'))) return 'HIDDEN';
  if (p.product_type.startsWith('shop-bundle')) return 'BUNDLE';
  if (subcategory.some((s) => season.excluded_subcategories.includes(s))) return 'OUT_OF_SEASON';
  if (!p.tags.some((t) => t.startsWith('Filterclass_'))) return 'NO_CLASS';
  if (clean.split(/\s+/).length < 20) return 'THIN_COPY';
  return null;
}

function mapped(tags: string[], unknown: Set<string>) {
  const rows: { family: string; value: string; row: MapRow }[] = [];
  for (const family of FAMILIES) for (const value of vals(tags, family)) {
    const row = map.values[family][value];
    if (!row) unknown.add(family + value);
    rows.push({ family, value, row: row ?? map.default });
  }
  return rows;
}

function normalise(p: Raw, unknown: Set<string>): Product {
  const available = p.variants.some((v) => v.available);
  const subcategory = vals(p.tags, 'Filtersubcategory_');
  const body_text_clean = available ? stripBody(p.body_html, p.title) : null;
  const m = mapped(p.tags, unknown);
  const cat = m.filter((x) => x.family === 'CATEGORY_');
  return { id: String(p.id), handle: p.handle, title: p.title, url: `https://www.nicobar.com/products/${p.handle}`, body_text_clean,
    category: vals(p.tags, 'Filtercategory_'), subcategory, class: vals(p.tags, 'Filterclass_'), subclass: vals(p.tags, 'Filtersubclass_'),
    wear_occasion: vals(p.tags, 'Filteroccasion_'), gift_occasion: cat.filter((x) => x.row.kind === 'occasion').map((x) => x.value),
    gift_recipient: cat.filter((x) => x.row.kind === 'recipient').map((x) => x.row.recipient ?? x.value), line: cat.filter((x) => x.row.kind === 'line').map((x) => x.value),
    room_or_use: vals(p.tags, 'Festive_', 'shopby_'), collection: vals(p.tags, 'COLLECTION_', 'pdpcollection_'),
    campaign: [...new Set(vals(p.tags, 'Campaign_', 'campaign_').map((c) => c.toLowerCase()))],
    occasion_keys: [...new Set(m.flatMap((x) => (x.row.kind === 'occasion' && x.row.key ? [x.row.key] : [])))],
    prior_tags: p.tags.filter((t) => PRIOR.has(t)), material: vals(p.tags, 'MATERIAL_')[0] ?? null, material_group: vals(p.tags, 'Material Group_')[0]?.toLowerCase() ?? null,
    colours: p.options.filter((o) => /^colou?r$/i.test(o.name)).flatMap((o) => o.values), gender: gender(p.tags), design_group: vals(p.tags, 'grouping_')[0] ?? null,
    badges: vals(p.tags, 'badge_'), is_bestseller_gift: p.tags.includes('Best_gift'), available,
    variants: p.variants.map((v) => ({ id: String(v.id), sku: v.sku || null, title: v.title, option1: v.option1, option2: v.option2, price: v.price, available: v.available })),
    images: p.images.map((i) => ({ src: i.src, src_canonical: i.src.split('?')[0], position: i.position, variant_ids: i.variant_ids.map(String) })),
    excluded_reason: excluded(p, subcategory, body_text_clean),
    content_sha256: sha256(JSON.stringify(p, (k, v) => (k === 'updated_at' ? undefined : v))) };
}

// C8 data.
const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|&/g;
const CONNECTIVES = new Set(['of', 'and', 'the', 'for', 'in', 'with', 'a', 'on', 'x', 'to', '&', 'by', 'at', 'from']);
const titleCore = (t: string) => t.replace(/\([^)]*\)/g, '').split(/\s[-–|]|[-–|]\s/)[0].trim();
const nounCore = (t: string) => t.replace(/\([^)]*\)/g, '').split(/\s*[-–|]\s*(?=[A-Z0-9])/)[0].trim();   // this split gives the 156 nouns; a stricter one gives 154
const BEFORE_RULE_7 = new Set(['NOT_AVAILABLE', 'NO_BODY', 'NO_IMAGE', 'NO_CATEGORY', 'HIDDEN']);
function isTitleCase(core: string) {
  const words = (core.match(WORD) ?? []).filter((w) => /[A-Za-z]/.test(w));
  return words.length >= 2 && /^[A-Z]/.test(words[0]) && words.every((w) => /^[A-Z]/.test(w) || CONNECTIVES.has(w.toLowerCase()));
}

function buildRules(raw: Raw[], rows: Product[]): Rules {
  const df = new Map<string, number>();
  for (const p of raw) for (const w of new Set(tagText(p.body_html).match(WORD) ?? []))
    if (w === w.toLowerCase() && /[a-z]/.test(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const cores = new Map<string, string>();      // one spelling per lower-cased core
  const finals = new Set<string>();
  for (const p of raw) {
    const core = titleCore(p.title);
    const last = nounCore(p.title).split(/\s+/).at(-1);
    if (last) finals.add(stem(last));
    if (isTitleCase(core)) cores.set(core.toLowerCase(), core);
  }
  const distinctive = [...cores.values()].filter((c) => (c.toLowerCase().match(WORD) ?? []).some((w) => /[a-z]/.test(w) && (df.get(w) ?? 0) <= 2));
  const classed = raw.filter((_, i) => !BEFORE_RULE_7.has(rows[i].excluded_reason ?? ''));   // stems are measured on rows that pass rules 1–6
  const classStems = new Set(classed.flatMap((p) => vals(p.tags, 'Filterclass_', 'Filtersubclass_').flatMap((v) => v.split(/[\s&/,_-]+/).filter((w) => w.length > 2).map(stem))));
  return { title_cores: [...cores.values()].sort(), distinctive_cores: distinctive.sort(), nouns: [...classStems].filter((s) => finals.has(s)).sort(), handles: raw.map((p) => p.handle) };
}

function invariants(rows: Product[]): void {
  const bad: string[] = [];
  for (const p of rows) {
    if (p.images.some((i) => !i.src_canonical.startsWith(IMAGE_PREFIX))) bad.push(`image host ${p.id}`);
    if (p.excluded_reason !== null) continue;
    const b = p.body_text_clean!;
    if (!passesC0(b) || !passesC4(b) || !passesC5(b) || b.split(/\s+/).length < 20) bad.push(`S1 ${p.id}`);
    if (p.subcategory.includes('Rakhi')) bad.push(`Rakhi ${p.id}`);
  }
  if (bad.length) throw new Error(`SNAPSHOT_INVARIANT_FAILED: ${bad.length}: ${bad.slice(0, 10).join(', ')}`);
}

interface Samples { fetched_at: string; gift_cards_removed: number; products: Raw[] }
export const readSamples = (dir = 'samples/site'): Samples => JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));

export function buildSnapshot({ products, fetched_at, gift_cards_removed }: Samples) {
  const raw = products.filter((p) => !isGiftCard(p));
  const unknown = new Set<string>();
  const rows = raw.map((p) => normalise(p, unknown));
  invariants(rows);
  const hash = sha256([...rows.map((p) => p.content_sha256)].sort().join('')).slice(0, 12);
  const snapshot_id = `${fetched_at.slice(0, 10)}-${hash}`;
  const excl: Record<string, number> = { GIFT_CARD: gift_cards_removed + products.length - raw.length };
  for (const p of rows) if (p.excluded_reason) excl[p.excluded_reason] = (excl[p.excluded_reason] ?? 0) + 1;
  const usable = rows.filter((p) => !p.excluded_reason).length;
  const after_class = usable + (excl.THIN_COPY ?? 0);
  const after_season = after_class + (excl.NO_CLASS ?? 0);
  const catalog: CatalogFile = { snapshot_id, fetched_at, rows };
  const report = { snapshot_id, fetched_at, source: 'https://www.nicobar.com/products.json', product_rows: rows.length, usable_rows: usable, excluded: excl,
    stages: { after_hidden_and_bundle: after_season + (excl.OUT_OF_SEASON ?? 0), after_season, after_class, usable }, unknown_occasion_values: [...unknown].sort() };
  return { catalog, rules: buildRules(raw, rows), report };
}

function wrangler(args: string[], persist: string | undefined) {
  execFileSync('npx', ['wrangler', ...args, '--local', ...(persist ? ['--persist-to', persist] : [])],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
}

function main() {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const { catalog, rules, report } = buildSnapshot(readSamples(arg('--samples')));
  const ids = ingestTsv(readFileSync('data/customers.with-c20.synthetic.tsv', 'utf8')).map((r) => r.key);
  const full = { ...report, row_keys: countKeys(ids, parseRowKeys(JSON.parse(readFileSync('data/row_keys.synthetic.json', 'utf8')))) };

  const id = report.snapshot_id;
  const dir = join('out', 'snapshot', id);
  mkdirSync(dir, { recursive: true });
  const files = { 'catalog.json': catalog, 'rules.json': rules, 'report.json': full };
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(v));

  if (process.argv.includes('--publish')) {
    const persist = arg('--persist-to');
    wrangler(['d1', 'migrations', 'apply', 'nicobar'], persist);
    wrangler(['d1', 'execute', 'nicobar', '--command', `INSERT OR IGNORE INTO snapshots (id, fetched_at, product_rows, usable_rows, synthetic) VALUES ('${id}', '${report.fetched_at}', ${report.product_rows}, ${report.usable_rows}, 0)`], persist);
    for (const f of Object.keys(files)) wrangler(['r2', 'object', 'put', `nicobar/snapshots/${id}/${f}`, '--file', join(dir, f)], persist);
  }
  console.log(`snapshot ${id}: ${report.product_rows} rows, ${report.usable_rows} usable, ${dir}${process.argv.includes('--publish') ? ', published locally' : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
