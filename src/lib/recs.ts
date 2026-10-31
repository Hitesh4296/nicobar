// Both files are untrusted input: an unparsable one stops the run before it starts (46 §3), so these throw.
import type { ReasonCode, RecFile, RecRow, RowKeys } from '../contracts/types.ts';

const REASONS: ReasonCode[] = ['OCCASION_MATCH', 'SAME_CLASS_NEW', 'SAME_MATERIAL', 'TRIP_TAG', 'FALLBACK_NON_OCCASION', 'HAND_SET', 'NEW_USER_PRIOR'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => k in v);
const fail = (why: string): never => { throw new Error(`recommendations: ${why}`); };

function parseRow(r: unknown): RecRow {
  if (!isObj(r) || !onlyKeys(r, ['customer_id', 'picks']) || typeof r.customer_id !== 'string' || !Array.isArray(r.picks)) return fail('bad row');
  if (r.picks.length > 6) fail('over 6 picks');
  for (const p of r.picks)
    if (!isObj(p) || !onlyKeys(p, ['product_id', 'reason_code']) || typeof p.product_id !== 'string' || !REASONS.includes(p.reason_code as ReasonCode)) fail('bad pick');
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
