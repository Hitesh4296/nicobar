// Prep steps 1–4. Step 5 is the workflow's.
import type { FailedCode } from '../contracts/codes.ts';
import type { Catalog, Customer, Group, IngestResult, MoreKind, Pick, Pinned, Plan, PlanMore, RecRow, RowKeys, RunFormat, ShapesFile, Signal, Slot } from '../contracts/types.ts';
import { computeShape } from './shape.ts';

const MIN_PICKS: Record<RunFormat, number> = { both: 4, landing_page: 4, email: 3 };

const groupOf = (category: string[]): Group => (category.includes('House & Home') ? 'home' : 'wear');
const displayName = (first: string | null) =>
  first?.split(' ').map((t) => (t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t)).join(' ') ?? null;

function resolvePicks(rec: RecRow, cat: Catalog, format: RunFormat): Pick[] | FailedCode {
  const picks: Pick[] = [];
  for (const [i, { product_id, reason_code }] of rec.picks.entries()) {
    const p = cat.rows.get(product_id);
    if (!p || p.excluded_reason !== null || picks.some((k) => k.product_id === product_id)) return 'INVALID_PICK';
    picks.push({ slot: `p${i + 1}` as Slot, product_id, reason_code, group: groupOf(p.category) });
  }
  return picks.length < MIN_PICKS[format] ? 'TOO_FEW_CANDIDATES' : picks;
}

const MORE_ORDER: Record<MoreKind, number> = { past_purchase: 0, occasion_category: 1, occasion: 2 };

/** Never fails a customer: the picks decide the outcome. Headings are built here, from code, the customer's occasion, if any, and a bounded label. */
function resolveMore(rec: RecRow, c: Customer, cat: Catalog): PlanMore[] {
  const drop = (code: string, detail: string) => console.log(JSON.stringify({ key: c.customer_id, step: 'more', status: 'dropped', code, detail }));
  const out: PlanMore[] = [];
  for (const s of [...(rec.more ?? [])].sort((a, b) => MORE_ORDER[a.kind] - MORE_ORDER[b.kind])) {
    const past = s.kind === 'past_purchase';
    // A gift was never theirs to pair with (c04, c12).
    if (past && (c.new_user || c.note_words?.includes('gift') || !c.note_words?.includes(s.label))) { drop('MORE_PAST_LABEL', s.label); continue; }
    const product_ids = s.product_ids.filter((id) => {
      const ok = cat.rows.get(id)?.excluded_reason === null;
      if (!ok) drop('MORE_ID', id);
      return ok;
    });
    if (!product_ids.length) { drop('MORE_EMPTY', s.kind); continue; }
    const heading = past ? `To go with your ${s.label}`
      : s.kind === 'occasion' ? (c.occasion ? `More for ${c.occasion}` : 'More from Nicobar')
      : c.occasion ? `${s.label} for ${c.occasion}` : s.label;
    out.push({ kind: s.kind, heading, product_ids });
  }
  return out;
}

function signalsOf(new_user: boolean, occasion: string | null, picks: Pick[]): Signal[] {
  if (!new_user) return [];
  return [...(occasion !== null ? ['occasion' as const] : []), ...(picks.some((p) => p.reason_code === 'NEW_USER_PRIOR') ? ['season_prior' as const] : [])];
}

// ponytail: the signature carries no run id or clock, so `prep` overwrites run_id and created_at. See the data hand-over.
export function planCustomer(item: IngestResult, rec: RecRow | null, keys: RowKeys, cat: Catalog, pinned: Pinned, s: ShapesFile): Plan {
  const base = { run_id: '', customer_id: item.key, created_at: pinned.run_date, pinned, format: pinned.format, admission: null };
  if (item.status !== 'ok') return { ...base, display_name: null, occasion: null, occasion_key: null, shape: null, new_user: false, picks: [], signals: [],
    outcome: { kind: 'failed', code: item.status === 'duplicate' ? 'DUPLICATE_CUSTOMER_ID' : 'INVALID_CUSTOMER' } };

  const { first_name, occasion, new_user, customer_id } = item.record;
  const result: Pick[] | FailedCode = rec ? resolvePicks(rec, cat, pinned.format) : new_user ? 'COLD_START_NO_HISTORY' : 'NO_RECOMMENDATION';
  const picks = typeof result === 'string' ? [] : result;
  const more = rec && typeof result !== 'string' ? resolveMore(rec, item.record, cat) : [];
  return { ...base, display_name: displayName(first_name), occasion, occasion_key: keys[customer_id]?.key ?? null, shape: computeShape(occasion, s), new_user,
    picks, ...(more.length ? { more } : {}), signals: signalsOf(new_user, occasion, picks), outcome: typeof result === 'string' ? { kind: 'failed', code: result as FailedCode } : { kind: 'ready' } };
}

/** The counts for report.json: rows with a null key, and ids the table does not hold. */
export function countKeys(customer_ids: string[], keys: RowKeys): { null_key: number; unknown_id: number } {
  const known = customer_ids.filter((id) => Object.hasOwn(keys, id));
  return { null_key: known.filter((id) => keys[id].key === null).length, unknown_id: customer_ids.length - known.length };
}
