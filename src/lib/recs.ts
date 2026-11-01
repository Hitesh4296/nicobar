// Both files are untrusted input: an unparsable one stops the run before it starts, so these throw.
import type { MoreKind, ReasonCode, RecFile, RecRow, RowKeys } from '../contracts/types.ts';

const REASONS: ReasonCode[] = ['OCCASION_MATCH', 'SAME_CLASS_NEW', 'SAME_MATERIAL', 'TRIP_TAG', 'FALLBACK_NON_OCCASION', 'HAND_SET', 'NEW_USER_PRIOR'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => k in v);
const fail = (why: string): never => { throw new Error(`recommendations: ${why}`); };

const KINDS: MoreKind[] = ['occasion', 'occasion_category', 'past_purchase'];
const LABEL: Record<MoreKind, RegExp> = { occasion: /^$/, occasion_category: /^[A-Z][A-Za-z &-]{0,39}$/, past_purchase: /^[a-z]+$/ };

// The why strings reach a reviewer's screen, so only these shapes pass.
const WHY = /^(occasion_tag:[a-z]+|goes_with:[a-z]+|fitted_class|row_fit|bestseller|prior_tag|new_arrival|fallback|hand_set|new_user)$/;
const okWhy = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every((s) => typeof s === 'string' && WHY.test(s));

/** The label reaches a heading, so it is bounded here. Whether it fits the customer is plan.ts's. */
function checkMore(more: unknown, pickIds: unknown[]): void {
  if (!Array.isArray(more) || more.length > 6) fail('bad more');
  const seen = new Set(pickIds);
  let past = 0;
  for (const s of more as unknown[]) {
    if (!isObj(s) || !onlyKeys(s, 'why' in s ? ['kind', 'label', 'product_ids', 'why'] : ['kind', 'label', 'product_ids']) || !KINDS.includes(s.kind as MoreKind) || typeof s.label !== 'string' || !LABEL[s.kind as MoreKind].test(s.label)
      || !Array.isArray(s.product_ids) || s.product_ids.length < 1 || s.product_ids.length > 24) return fail('bad more section');
    if (s.kind === 'past_purchase' && ++past > 1) fail('over 1 past_purchase');
    for (const id of s.product_ids) {
      if (typeof id !== 'string' || seen.has(id)) fail('bad or repeated more id');
      seen.add(id);
    }
    if ('why' in s && (!isObj(s.why) || !Object.entries(s.why).every(([id, w]) => (s.product_ids as unknown[]).includes(id) && okWhy(w)))) fail('bad more why');
  }
  if (seen.size - new Set(pickIds).size > 60) fail('over 60 more ids');
}

function parseRow(r: unknown): RecRow {
  if (!isObj(r) || !onlyKeys(r, 'more' in r ? ['customer_id', 'picks', 'more'] : ['customer_id', 'picks']) || typeof r.customer_id !== 'string' || !Array.isArray(r.picks)) return fail('bad row');
  if (r.picks.length > 6) fail('over 6 picks');
  for (const p of r.picks)
    if (!isObj(p) || !onlyKeys(p, 'why' in p ? ['product_id', 'reason_code', 'why'] : ['product_id', 'reason_code']) || typeof p.product_id !== 'string' || !REASONS.includes(p.reason_code as ReasonCode) || ('why' in p && !okWhy(p.why))) fail('bad pick');
  if ('more' in r) checkMore(r.more, (r.picks as { product_id: string }[]).map((p) => p.product_id));
  return r as unknown as RecRow;
}

export function parseRecs(json: unknown): RecFile {
  if (!isObj(json) || json.version !== 'recommendations/v1') return fail('wrong version');
  const { synthetic, as_of, snapshot_id, rule, rows } = json;
  if (typeof synthetic !== 'boolean' || typeof as_of !== 'string' || typeof snapshot_id !== 'string' || typeof rule !== 'string' || !Array.isArray(rows)) return fail('bad header');
  const parsed = rows.map(parseRow);
  if (new Set(parsed.map((r) => r.customer_id)).size !== parsed.length) fail('repeated customer');
  return { version: 'recommendations/v1', synthetic, as_of, snapshot_id, rule, rows: parsed };
}

export function parseRowKeys(json: unknown): RowKeys {
  if (!isObj(json)) throw new Error('row_keys: not an object');
  for (const [id, v] of Object.entries(json))
    if (!isObj(v) || !onlyKeys(v, ['key']) || !(typeof v.key === 'string' || v.key === null)) throw new Error(`row_keys: ${id} must be exactly {key}`);
  return json as RowKeys;
}
