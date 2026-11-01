// The ranking engine (R127, R128, R134): filter, then a weighted score, then fixed guards. A stable hash breaks ties.
// ponytail: hand-set row rules; ceiling = these 20 rows, upgrade = a real recommender writing the same file.
import { createHash } from 'node:crypto';
import type { Catalog, MoreKind, MoreSection, Plan, PoolCounts, Product, RankingBy, ReasonCode, RecPick, RecRow, RowKeys, Weights } from '../../contracts/types.ts';

export interface RankCustomer { customer_id: string; occasion: string|null; note: string|null }
export interface RankRow { type: 'wear'|'gift'|'home'|'new_user'; picks: number; key: string|null; pool?: string; recipient?: 'him'|'her'; note_gender?: 'f'; everyday_pool?: boolean; hand?: string[] }
export interface RankConfig {
  version: string; weights: Weights;
  limits: { family_cap: number; family_cap_max: number; rail: number; occasion_rail: number; category_rails: number; category_min: number };
  barred: { class: string[]; subcategory: string[]; handle_words: string[] };
  gift_keys: string[]; fresh_badge: string; pools: Record<string, string[]>; plurals: Record<string, string>;
  complements: Record<string, { class: string }[]>; new_user_picks: string[]; rows: Record<string, RankRow>;
}
type RankingFile = Omit<RankConfig, 'rows'> & { rows: Record<string, unknown> };
type Key = (number|string)[];

export const WEIGHTS = ['occasion', 'season', 'bestseller', 'new', 'past'] as const;

/** Refuses weights that could lift a past purchase over the occasion. R128: this holds for any saved weights. */
export function checkWeights(w: Weights): Weights {
  for (const k of WEIGHTS) if (!Number.isFinite(w[k]) || w[k] < 0) throw new Error(`rank: weight ${k} must be a number, 0 or above`);
  if (Object.keys(w).length !== 5) throw new Error('rank: unknown weight');
  if (w.occasion === 0) throw new Error('rank: the occasion weight cannot be 0');
  if (w.past >= w.occasion) throw new Error('rank: past must stay below occasion');
  if (w.season + w.bestseller + w.new + w.past >= w.occasion) throw new Error('rank: occasion must outweigh the other four together');
  return w;
}

/** ranking.json, plus the two data files that stay where they are. */
export const rankConfig = (f: unknown, keys: RowKeys, hand: Record<string, { picks: string[] }>): RankConfig => {
  const file = f as RankingFile;
  checkWeights(file.weights);
  return { ...file, rows: Object.fromEntries(Object.entries(file.rows).map(([c, r]) => [c, { ...(r as RankRow), key: keys[c]?.key ?? null, ...(hand[c] ? { hand: hand[c].picks } : {}) }])) };
};

/** customers/v2, keeping the note the ingest step rightly drops. Blank fields are null. */
export function readCustomers(tsv: string): RankCustomer[] {
  return tsv.split('\n').slice(1).filter((l) => l.trim()).map((l) => {
    const [customer_id, , , occasion, note] = l.split('\t');
    return { customer_id, occasion: occasion || null, note: note?.trim() || null };
  });
}

const cl = (p: Product) => p.class[0];
const home = (p: Product) => p.category.includes('House & Home');
const masc = (p: Product) => p.category.includes('Men') || p.gender === 'male';
const fem = (p: Product) => p.category.includes('Women') || p.gender === 'female';
const family = (p: Product) => (p.category.includes('Jewellery') ? 'Jewellery' : p.subcategory[0] ?? cl(p));
const group = (p: Product) => p.design_group ?? p.handle;
const core = (p: Product) => p.title.split(' - ')[0];
const hash = (c: string, p: Product) => createHash('sha256').update(c + p.id).digest('hex');
const gendered = (p: Product) => p.category.includes('Men') || p.category.includes('Women');
/** Category and gender can disagree (six Men rows are `female`), so neither is read alone. */
const neutral = (p: Product) => (gendered(p) ? p.gender === 'any' : p.gender !== 'female' && p.gender !== 'male');

const barred = (p: Product, cfg: RankConfig) => cfg.barred.class.some((k) => p.class.includes(k)) || cfg.barred.subcategory.some((k) => p.subcategory.includes(k)) || cfg.barred.handle_words.some((w) => p.handle.includes(w));

/** Tier 2. A row's gender comes only from its note or stated recipient, and a both-tagged product is out of a single-gender row. */
function fits(p: Product, row: RankRow, cfg: RankConfig): boolean {
  if (row.type === 'new_user') return p.prior_tags.length > 0 && neutral(p);
  if (row.pool) return neutral(p) && !home(p) && cfg.pools[row.pool].includes(cl(p));
  if (row.type === 'home') return home(p);
  if (row.type === 'gift') {
    if (row.everyday_pool && !p.occasion_keys.includes('everyday') && !p.is_bestseller_gift) return false;
    if (!row.recipient) return !gendered(p) && neutral(p);   // No stated gender, so no lean either way.
    return p.gift_recipient.includes(row.recipient) && !(row.recipient === 'him' ? fem(p) : masc(p));
  }
  return !home(p) && (neutral(p) || (row.note_gender === 'f' && fem(p) && !masc(p)));
}

/** The note's noun, when the table knows it. A gift was never theirs to pair with. */
function pastWord(c: RankCustomer, cfg: RankConfig): string|null {
  if (!c.note || /\bgift\b/.test(c.note)) return null;
  const word = c.note.match(/^Bought the (.+?)(?: (?:last|for|before|as|to|and)\b|\.|$)/)?.[1].split(' ').at(-1);
  return word && Object.hasOwn(cfg.complements, word) ? word : null;
}

/** Every signal, in tier order: what ranks the product is what explains it. */
export function signalsOf(c: RankCustomer, p: Product, row: RankRow, cfg: RankConfig): string[] {
  const word = pastWord(c, cfg), out: string[] = [];
  if (row.key && p.occasion_keys.includes(row.key)) out.push(`occasion_tag:${row.key}`);
  if (row.pool && cfg.pools[row.pool].includes(cl(p))) out.push('fitted_class');
  if (word && cfg.complements[word].some((x) => p.class.includes(x.class))) out.push(`goes_with:${word}`);
  // The tag is Best_gift: it says nothing about what to wear to a wedding, so it speaks only on a gift row.
  if (p.is_bestseller_gift && (row.type === 'gift' || (row.key !== null && cfg.gift_keys.includes(row.key)))) out.push('bestseller');
  if (p.prior_tags.length) out.push('prior_tag');
  if (p.badges.includes(cfg.fresh_badge)) out.push('new_arrival');
  return out;
}

const isTier1 = (s: string[]) => s.some((x) => x.startsWith('occasion_tag') || x === 'fitted_class');
const isPast = (s: string[]) => s.some((x) => x.startsWith('goes_with'));
/** The sum of the matched signals. A product counts for the occasion once, by tag or by fitted class. */
export function scoreOf(s: string[], w: Weights): number {
  return (isTier1(s) ? w.occasion : 0) + (s.includes('prior_tag') ? w.season : 0) + (s.includes('bestseller') ? w.bestseller : 0) + (s.includes('new_arrival') ? w.new : 0) + (isPast(s) ? w.past : 0);
}
const compare = (a: Key, b: Key) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

function take(cand: Product[], n: number, cap: number): Product[] {
  const picks: Product[] = [];
  for (const p of cand) {
    if (picks.length === n) break;
    if (picks.some((q) => cl(q) === cl(p) || group(q) === group(p))) continue;
    if (picks.filter((q) => family(q) === family(p)).length >= cap) continue;
    picks.push(p);
  }
  return picks;
}

export const RANK_RULE = 'Internal ranking engine, src/lib/rank with config/ranking.json. Filter, then a weighted score, then fixed guards: the first pick fits the occasion and is never past-only, one per class, at most two per family where the pool allows. A stable hash breaks ties. Hand table for c02 c03 c06 c13 c15 c18 (HAND_SET), pinned and resorted so p1 obeys the rule; pinned new-user picks for c20 (NEW_USER_PRIOR). Row rules and the complements table are hand-written and synthetic, no behaviour data. A real recommender can replace this file by contract.';

export interface RowPool { gated: Product[]; tier1: Product[]; past: Product[]; signals: Map<string, string[]>; sorted: (ps: Product[]) => Product[] }

/** Everything this row may show, with the comparator that orders it. */
export function poolOf(c: RankCustomer, cat: Pick<Catalog, 'usable'>, cfg: RankConfig, weights: Weights = cfg.weights): RowPool {
  const row = cfg.rows[c.customer_id];
  const gated = cat.usable.filter((p) => p.available && !barred(p, cfg) && fits(p, row, cfg));
  const signals = new Map(cat.usable.map((p) => [p.id, signalsOf(c, p, row, cfg)]));
  const key = (p: Product): Key => [-scoreOf(signals.get(p.id)!, weights), hash(c.customer_id, p)];
  const sorted = (ps: Product[]) => ps.map((p) => [key(p), p] as const).sort((a, b) => compare(a[0], b[0])).map((x) => x[1]);
  return { gated, signals, sorted, tier1: gated.filter((p) => isTier1(signals.get(p.id)!)), past: gated.filter((p) => isPast(signals.get(p.id)!)) };
}

function choosePicks(row: RankRow, x: RowPool, cfg: RankConfig): Product[] {
  const cand = x.sorted(x.gated);
  const fits1 = (p: Product) => isTier1(x.signals.get(p.id)!);
  const pastOnly = (p: Product) => !fits1(p) && isPast(x.signals.get(p.id)!);
  // The hero guard: an occasion product when one exists, and never a past-only one.
  const head = cand.some(fits1) ? cand.findIndex(fits1) : cand.findIndex((p) => !pastOnly(p));
  if (head < 0) return [];                         // Only past-only products: no p1 at all, and the plan fails this row by name.
  const ordered = [cand[head], ...cand.filter((_, i) => i !== head)];
  for (let cap = cfg.limits.family_cap; cap <= cfg.limits.family_cap_max; cap++) {
    const picks = take(ordered, row.picks, cap);
    if (picks.length === row.picks) return picks;
  }
  return take(ordered, row.picks, cfg.limits.family_cap_max);
}

const reasonOf = (s: string[]): ReasonCode => (s.some((v) => v.startsWith('occasion_tag')) ? 'OCCASION_MATCH' : s.includes('fitted_class') ? 'TRIP_TAG' : 'FALLBACK_NON_OCCASION');
const pick = (p: Product, s: string[], reason_code: ReasonCode, name: string, w: Weights): RecPick => ({ product_id: p.id, reason_code, why: [...s, ...(name ? [name] : [])], score: scoreOf(s, w) });

function pinned(handles: string[], c: string, cat: Pick<Catalog, 'usable'>): Product[] {
  return handles.map((h) => cat.usable.find((p) => p.handle === h) ?? (() => { throw new Error(`rank: ${c} pins ${h}, not in the snapshot`); })());
}

/** Round robin over classes, deepest first; repeat colourways of one design last. */
function roundRobin(ps: Product[], n: number, x: RowPool): Product[] {
  const by = new Map<string, Product[]>();
  for (const p of x.sorted(ps)) by.set(cl(p), [...(by.get(cl(p)) ?? []), p]);
  for (const [k, v] of by) {
    const seen = new Map<string, number>();
    const once = v.map((p) => { const i = seen.get(core(p)) ?? 0; seen.set(core(p), i + 1); return [i, p] as const; });
    by.set(k, once.sort((a, b) => a[0] - b[0]).map((e) => e[1]));
  }
  const order = [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length || (a < b ? -1 : 1));
  const out: Product[] = [];
  for (let i = 0; i < Math.max(0, ...[...by.values()].map((v) => v.length)); i++) for (const k of order) if (by.get(k)![i]) out.push(by.get(k)![i]);
  return out.slice(0, n);
}

const plural = (k: string, cfg: RankConfig) => cfg.plurals[k] ?? k;

/** The past rail fills first, so it keeps its size on a thin row, and renders last. A product sits in one rail only. */
function chooseMore(c: RankCustomer, row: RankRow, picks: Product[], x: RowPool, cfg: RankConfig): MoreSection[] {
  const { rail, occasion_rail, category_rails, category_min } = cfg.limits;
  const used = new Set(picks.map((p) => p.id)), more: MoreSection[] = [];
  const section = (kind: MoreKind, label: string, ps: Product[]) => {
    for (const p of ps) used.add(p.id);
    more.push({ kind, label, product_ids: ps.map((p) => p.id), why: Object.fromEntries(ps.map((p) => [p.id, x.signals.get(p.id)!.length ? x.signals.get(p.id)! : ['row_fit']])) });
  };
  const open = (ps: Product[]) => ps.filter((p) => !used.has(p.id));
  const tagged = row.type === 'new_user' ? x.gated : x.gated.filter((p) => row.key !== null && p.occasion_keys.includes(row.key));

  const word = pastWord(c, cfg);
  if (word) {
    const cand = open(x.past);
    const first = roundRobin(cand.filter((p) => isTier1(x.signals.get(p.id)!)), rail, x);
    const ps = [...first, ...roundRobin(cand.filter((p) => !first.includes(p) && !isTier1(x.signals.get(p.id)!)), rail - first.length, x)];
    if (ps.length) section('past_purchase', word, ps);
  }

  const left = open(row.pool || row.everyday_pool || row.type === 'new_user' ? x.gated : tagged);
  const depth = new Map<string, Product[]>();
  for (const p of left) if (cl(p)) depth.set(cl(p), [...(depth.get(cl(p)) ?? []), p]);   // an enabled product with no class has no section of its own
  const order = [...depth].filter(([, v]) => v.length >= category_min).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const chosen: string[] = [];
  for (const [k, v] of order) if (chosen.length < category_rails && !chosen.some((q) => family(depth.get(q)![0]) === family(v[0]))) chosen.push(k);
  for (const [k] of order) if (chosen.length < category_rails && !chosen.includes(k)) chosen.push(k);
  for (const k of chosen) section('occasion_category', plural(k, cfg), roundRobin(depth.get(k)!, rail, x));

  const rest = open(tagged);
  if (rest.length) section('occasion', '', roundRobin(rest, occasion_rail, x));

  return [...more.filter((s) => s.kind !== 'past_purchase'), ...more.filter((s) => s.kind === 'past_purchase')];
}

export function rankCustomer(c: RankCustomer, cat: Pick<Catalog, 'usable'>, cfg: RankConfig, w: Weights = cfg.weights): RecRow {
  const row = cfg.rows[c.customer_id], x = poolOf(c, cat, cfg, w);
  const signal = (p: Product) => x.signals.get(p.id)!;
  let chosen: Product[], picks: RecPick[];
  if (row.type === 'new_user') {
    chosen = pinned(cfg.new_user_picks, c.customer_id, cat);
    picks = chosen.map((p) => pick(p, signal(p), 'NEW_USER_PRIOR', 'new_user', w));
  } else if (row.hand) {
    // Pinned, so only the order can move: tier 1 first, past-only last, the hand's order otherwise.
    const place = (p: Product) => (isTier1(signal(p)) ? 0 : isPast(signal(p)) ? 2 : 1);
    chosen = pinned(row.hand, c.customer_id, cat).sort((a, b) => place(a) - place(b));
    picks = chosen.map((p) => pick(p, signal(p), 'HAND_SET', 'hand_set', w));
  } else {
    chosen = choosePicks(row, x, cfg);
    picks = chosen.map((p) => { const code = reasonOf(signal(p)); return pick(p, signal(p), code, code === 'FALLBACK_NON_OCCASION' ? 'fallback' : '', w); });
  }
  const more = picks.length ? chooseMore(c, row, chosen, x, cfg) : [];
  const pool: PoolCounts = { filtered: x.gated.length, on_occasion: x.tier1.length, past: x.past.length };
  return { customer_id: c.customer_id, picks, ...(more.length ? { more } : {}), pool };
}

/** What wrote this ranking, for `generated_by`. */
export const rankingBy = (cfg: RankConfig, snapshot_id: string, catalog_version?: string): RankingBy => ({ method: 'weights', version: cfg.version, weights: cfg.weights,
  rules: ['hero fits the occasion', 'one per class', `${cfg.limits.family_cap} per family`], snapshot_id, cost: 0, ...(catalog_version ? { catalog_version } : {}) });

export type Change = { kind: 'unchanged' } | { kind: 'sections'; rails: string[] } | { kind: 'picks'; before: string[]; after: string[] };

/** Picks or their order change the words, so a redraft. Rails are code-built, so they re-render. */
export function changeOf(stored: Pick<Plan, 'picks'|'more'>, next: Pick<Plan, 'picks'|'more'>): Change {
  const ids = (p: Pick<Plan, 'picks'>) => p.picks.map((k) => k.product_id);
  if (ids(stored).join() !== ids(next).join()) return { kind: 'picks', before: ids(stored), after: ids(next) };
  const rail = (m: NonNullable<Plan['more']>[number]) => `${m.heading}: ${m.product_ids.join()}`;
  const a = (stored.more ?? []).map(rail), b = (next.more ?? []).map(rail);
  return a.join('\n') === b.join('\n') ? { kind: 'unchanged' } : { kind: 'sections', rails: (next.more ?? []).filter((_, i) => a[i] !== b[i]).map((m) => m.heading) };
}

/** A customer with no row rule is skipped: the plan then fails that one by name, and the rest go on. */
export const rankAll = (customers: RankCustomer[], cat: Pick<Catalog, 'usable'>, cfg: RankConfig): RecRow[] => customers.filter((c) => cfg.rows[c.customer_id]).map((c) => rankCustomer(c, cat, cfg));
