// P0 and P1 rules, and overrides on a snapshot (R137). P0 is held here, on every read of a version: nothing that saves one can let a P0 product through.
import rulesJson from '../../../config/usable_rules.json' with { type: 'json' };
import type { Catalog, CatalogOverride, Product } from '../../contracts/types.ts';
import type { RankConfig } from '../rank/index.ts';

export interface Bar { class?: string[]; subcategory?: string[]; handle_words?: string[] }
export interface Rule { id: string; name: string; priority: string; why: string; if_enabled?: string; bar?: Bar }
export type Status = 'usable'|'p0'|'p1'|'enabled'|'disabled';
export interface Sets { off: Set<string>; on: Set<string>; out: Set<string> }

export const RULES = rulesJson.rules as Rule[];
export const EMPTY: CatalogOverride = { rules_off: [], enabled: [], disabled: [] };
const P0 = new Set(RULES.filter((r) => r.priority === 'P0').map((r) => r.id));
const BARS = RULES.filter((r) => r.bar);
export const isP0 = (id: string) => P0.has(id);
export const sets = (o: CatalogOverride): Sets => ({ off: new Set(o.rules_off), on: new Set(o.enabled), out: new Set(o.disabled) });

const barred = (p: Product, b: Bar) => !!b.class?.some((k) => p.class.includes(k)) || !!b.subcategory?.some((k) => p.subcategory.includes(k)) || !!b.handle_words?.some((w) => p.handle.includes(w));

/** Every reason, bars included. The P0 fields are read again, and a row with no recorded list cannot be overridden: its other reasons are unknown. */
export function reasonsOf(p: Product): string[] {
  const recorded = p.excluded_reasons ?? (p.excluded_reason ? [p.excluded_reason, 'NOT_RECORDED'] : []);
  return [...new Set([...recorded, ...(p.available ? [] : ['NOT_AVAILABLE']), ...(p.images.length ? [] : ['NO_IMAGE']), ...(p.available && !p.body_text_clean ? ['NO_BODY'] : []),
    ...BARS.filter((r) => barred(p, r.bar!)).map((r) => r.id)])];
}

export function statusOf(p: Product, s: Sets, reasons = reasonsOf(p)): Status {
  if (reasons.some(isP0)) return 'p0';
  if (s.out.has(p.id)) return 'disabled';
  if (!reasons.length) return 'usable';
  return s.on.has(p.id) || reasons.every((r) => s.off.has(r)) ? 'enabled' : 'p1';
}

/** A new catalog; `loadCatalog`'s is shared and cached. A row out of use carries the reason the plan refuses it for. */
export function applyCatalog(cat: Catalog, o: CatalogOverride): Catalog {
  const s = sets(o), rows = new Map<string, Product>(), usable: Product[] = [];
  for (const [id, p] of cat.rows) {
    const reasons = reasonsOf(p), status = statusOf(p, s, reasons), live = status === 'usable' || status === 'enabled';
    const excluded_reason = live ? null : status === 'disabled' ? 'DISABLED' : reasons.find((r) => !s.off.has(r)) ?? reasons[0];
    const row = p.excluded_reason === excluded_reason ? p : { ...p, excluded_reason };
    rows.set(id, row);
    if (live) usable.push(row);
  }
  return { ...cat, rows, usable };
}

/** The usable set now holds the bars and the overrides, so the ranking's own bars stand down, and a pin that is out leaves its customer short: the plan then fails that one by name. */
export function rankConfigFor(cfg: RankConfig, cat: Pick<Catalog, 'usable'>): RankConfig {
  const live = new Set(cat.usable.map((p) => p.handle)), keep = (h: string) => live.has(h);
  return { ...cfg, barred: { class: [], subcategory: [], handle_words: [] }, new_user_picks: cfg.new_user_picks.filter(keep),
    rows: Object.fromEntries(Object.entries(cfg.rows).map(([c, r]) => [c, r.hand ? { ...r, hand: r.hand.filter(keep) } : r])) };
}
