// The ranking engine (R127). Tiers are compared in order and never added: a weight can be outvoted, a tier cannot.
// ponytail: hand-set row rules; ceiling = these 20 rows, upgrade = a real recommender writing the same file.
import { createHash } from 'node:crypto';
import type { Catalog, MoreKind, MoreSection, Product, ReasonCode, RecPick, RecRow, RowKeys } from '../../contracts/types.ts';

export interface RankCustomer { customer_id: string; occasion: string|null; note: string|null }
export interface RankRow { type: 'wear'|'gift'|'home'|'new_user'; picks: number; key: string|null; pool?: string; recipient?: 'him'|'her'; note_gender?: 'f'; everyday_pool?: boolean; hand?: string[] }
export interface RankConfig {
  limits: { family_cap: number; family_cap_max: number; rail: number; occasion_rail: number; category_rails: number; category_min: number };
  barred: { class: string[]; subcategory: string[]; handle_words: string[] };
  fill: string[]; gift_keys: string[]; fresh_badge: string; pools: Record<string, string[]>; plurals: Record<string, string>;
  complements: Record<string, { class: string }[]>; new_user_picks: string[]; rows: Record<string, RankRow>;
}
type RankingFile = Omit<RankConfig, 'rows'> & { rows: Record<string, unknown> };
type Key = (number|string)[];

/** ranking.json, plus the two data files that stay where they are. */
export const rankConfig = (f: unknown, keys: RowKeys, hand: Record<string, { picks: string[] }>): RankConfig => {
  const file = f as RankingFile;
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

export interface RowPool { gated: Product[]; tier1: Product[]; past: Product[]; signals: Map<string, string[]>; sorted: (ps: Product[]) => Product[] }

/** Everything this row may show, with the comparator that orders it. */
export function poolOf(c: RankCustomer, cat: Pick<Catalog, 'usable'>, cfg: RankConfig): RowPool {
  const row = cfg.rows[c.customer_id];
  const gated = cat.usable.filter((p) => p.available && !barred(p, cfg) && fits(p, row, cfg));
  const signals = new Map(cat.usable.map((p) => [p.id, signalsOf(c, p, row, cfg)]));
  const has = (s: string[], x: string) => (s.includes(x) ? 0 : 1);
  const key = (p: Product): Key => { const s = signals.get(p.id)!; return [isTier1(s) ? 0 : 1, isPast(s) ? 0 : 1, has(s, 'bestseller'), has(s, 'prior_tag'), has(s, 'new_arrival'), hash(c.customer_id, p)]; };
  const sorted = (ps: Product[]) => ps.map((p) => [key(p), p] as const).sort((a, b) => compare(a[0], b[0])).map((x) => x[1]);
  return { gated, signals, sorted, tier1: gated.filter((p) => isTier1(signals.get(p.id)!)), past: gated.filter((p) => isPast(signals.get(p.id)!)) };
}

function choosePicks(c: RankCustomer, row: RankRow, x: RowPool, cfg: RankConfig): Product[] {
  const tier1 = x.sorted(x.tier1), off = x.gated.filter((p) => !isTier1(x.signals.get(p.id)!));
  const festive = (p: Product) => (p.occasion_keys.includes('festive') ? 0 : 1);
  // The fallback is its own order: past purchase is a tie-break inside tier 1 and has no say here.
  const fill = off.filter((p) => cfg.fill.includes(cl(p))).map((p) => [[cfg.fill.indexOf(cl(p)), festive(p), hash(c.customer_id, p)] as Key, p] as const).sort((a, b) => compare(a[0], b[0])).map((v) => v[1]);
  const rest = x.sorted(off.filter((p) => !fill.includes(p)));
  const pastOnly = (p: Product) => !isTier1(x.signals.get(p.id)!) && isPast(x.signals.get(p.id)!);
  for (const cand of [[...tier1, ...fill], [...tier1, ...fill, ...rest]]) {
    const head = cand.findIndex((p) => !pastOnly(p));
    if (head < 0) return [];                       // Only past-only products: no p1 at all, and the plan fails this row by name.
    const ordered = [cand[head], ...cand.filter((_, i) => i !== head)];
    for (let cap = cfg.limits.family_cap; cap <= cfg.limits.family_cap_max; cap++) {
      const picks = take(ordered, row.picks, cap);
      if (picks.length === row.picks) return picks;
    }
  }
  return take([...tier1, ...fill, ...rest], row.picks, cfg.limits.family_cap_max);
}

const reasonOf = (s: string[]): ReasonCode => (s.some((v) => v.startsWith('occasion_tag')) ? 'OCCASION_MATCH' : s.includes('fitted_class') ? 'TRIP_TAG' : 'FALLBACK_NON_OCCASION');
const pick = (p: Product, s: string[], reason_code: ReasonCode, name: string): RecPick => ({ product_id: p.id, reason_code, why: [...s, ...(name ? [name] : [])] });

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
  for (const p of left) depth.set(cl(p), [...(depth.get(cl(p)) ?? []), p]);
  const order = [...depth].filter(([, v]) => v.length >= category_min).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const chosen: string[] = [];
  for (const [k, v] of order) if (chosen.length < category_rails && !chosen.some((q) => family(depth.get(q)![0]) === family(v[0]))) chosen.push(k);
  for (const [k] of order) if (chosen.length < category_rails && !chosen.includes(k)) chosen.push(k);
  for (const k of chosen) section('occasion_category', plural(k, cfg), roundRobin(depth.get(k)!, rail, x));

  const rest = open(tagged);
  if (rest.length) section('occasion', '', roundRobin(rest, occasion_rail, x));

  return [...more.filter((s) => s.kind !== 'past_purchase'), ...more.filter((s) => s.kind === 'past_purchase')];
}

export function rankCustomer(c: RankCustomer, cat: Pick<Catalog, 'usable'>, cfg: RankConfig): RecRow {
  const row = cfg.rows[c.customer_id], x = poolOf(c, cat, cfg);
  const signal = (p: Product) => x.signals.get(p.id)!;
  let chosen: Product[], picks: RecPick[];
  if (row.type === 'new_user') {
    chosen = pinned(cfg.new_user_picks, c.customer_id, cat);
    picks = chosen.map((p) => pick(p, signal(p), 'NEW_USER_PRIOR', 'new_user'));
  } else if (row.hand) {
    // Pinned, so only the order can move: tier 1 first, past-only last, the hand's order otherwise.
    const place = (p: Product) => (isTier1(signal(p)) ? 0 : isPast(signal(p)) ? 2 : 1);
    chosen = pinned(row.hand, c.customer_id, cat).sort((a, b) => place(a) - place(b));
    picks = chosen.map((p) => pick(p, signal(p), 'HAND_SET', 'hand_set'));
  } else {
    chosen = choosePicks(c, row, x, cfg);
    picks = chosen.map((p) => { const code = reasonOf(signal(p)); return pick(p, signal(p), code, code === 'FALLBACK_NON_OCCASION' ? 'fallback' : ''); });
  }
  const more = picks.length ? chooseMore(c, row, chosen, x, cfg) : [];
  return { customer_id: c.customer_id, picks, ...(more.length ? { more } : {}) };
}

export const rankAll = (customers: RankCustomer[], cat: Pick<Catalog, 'usable'>, cfg: RankConfig): RecRow[] => customers.map((c) => rankCustomer(c, cat, cfg));
