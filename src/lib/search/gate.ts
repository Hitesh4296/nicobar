// Code decides (R141). What the model chose passes through here, at planning and again at every rank, so a hand-edited file gets no further than a model.
import type { Product } from '../../contracts/types.ts';
import { known, search, type Filters, type SearchIndex } from './index.ts';

export interface PlanSection { purpose: string; all: Filters; not?: Filters; from_past?: boolean }
export interface PlanRow { primary: PlanSection; sections: PlanSection[] }
export interface QueriesFile { version: 'queries/v1'; synthetic: boolean; model: string; prompt_sha256: string; date: string; snapshot_id: string; rows: Record<string, PlanRow> }
export interface GateContext { occasion: string|null; note_gender?: 'f'; past: string|null; admit: (p: Product) => boolean }
export interface Gated { primary: PlanSection|null; sections: PlanSection[]; log: string[] }

export const MIN_RESULTS = 3;
const MAX_SECTIONS = 6;

/** Who a filter may be for. Only the occasion text or the existing note rule says. */
export function statedGender(occasion: string|null, note_gender?: 'f'): 'him'|'her'|null {
  if (/\bfather\b/i.test(occasion ?? '')) return 'him';
  if (/\bmother\b/i.test(occasion ?? '') || note_gender === 'f') return 'her';
  return null;
}
const GENDERED: Record<string, Record<string, 'him'|'her'>> = { recipient: { him: 'him', her: 'her' }, category: { Men: 'him', Women: 'her' }, looks: { him: 'him', her: 'her' } };

function clean(f: Filters, who: 'him'|'her'|null, index: SearchIndex, log: string[]): Filters {
  const out: Filters = {};
  for (const [family, vals] of Object.entries(f)) for (const v of vals) {
    if (!known(index, family, v)) { log.push(`dropped ${family}=${v}: not in the vocabulary`); continue; }
    const g = GENDERED[family]?.[v];
    if (g && g !== who) { log.push(`dropped ${family}=${v}: the customer did not state it`); continue; }
    (out[family] ??= []).push(v);
  }
  return out;
}

const hits = (all: Filters, not: Filters|undefined, index: SearchIndex, admit: GateContext['admit']) => search({ all, not }, index).ids.filter((id) => admit(index.products.get(id)!));

/** Zero results relaxes the last filter, down to one filter left. */
function relaxed(s: PlanSection, who: 'him'|'her'|null, index: SearchIndex, ctx: GateContext, log: string[]): PlanSection|null {
  const all = clean(s.all, who, index, log), not = s.not ? clean(s.not, null, index, log) : undefined;
  while (Object.keys(all).length > 1 && !hits(all, not, index, ctx.admit).length) {
    const last = Object.keys(all).at(-1)!;
    log.push(`relaxed ${last}=${all[last].join('|')}: "${s.purpose}" found nothing`);
    delete all[last];
  }
  const n = Object.keys(all).length ? hits(all, not, index, ctx.admit).length : 0;
  if (n < MIN_RESULTS) { log.push(`dropped query "${s.purpose}": ${n} results`); return null; }
  return { ...s, all, ...(not ? { not } : {}) };
}

export function gatePlan(row: PlanRow, ctx: GateContext, index: SearchIndex): Gated {
  const log: string[] = [], who = statedGender(ctx.occasion, ctx.note_gender);
  const { from_past: _, ...first } = row.primary;
  const primary = relaxed(first, who, index, ctx, log);
  const sections = row.sections.slice(0, MAX_SECTIONS).flatMap((s) => {
    if (s.from_past && !ctx.past) { log.push(`dropped query "${s.purpose}": no past item to follow`); return []; }
    const r = relaxed(s, who, index, ctx, log);
    return r ? [r] : [];
  });
  return { primary, sections, log };
}
