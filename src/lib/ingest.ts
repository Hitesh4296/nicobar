// customers/v2. last_name and the note stop here: neither enters a result, and no error quotes a row.
import type { IngestResult } from '../contracts/types.ts';

const HEADER = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NO_HISTORY = new Set(['', '-', 'n/a', 'none', 'null']);

/** A file-level failure: `POST /api/runs` answers 400 and writes no run row. */
export class BadCustomerFile extends Error {
  code = 'BAD_INPUT' as const;
}

export function ingestTsv(text: string): IngestResult[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== HEADER) throw new BadCustomerFile('wrong header');
  const rows = lines.slice(1).map((l) => l.split('\t'));
  if (!rows.length) throw new BadCustomerFile('no rows');

  const wellFormed = (r: string[]) => r.length === 5 && ID.test(r[0]);
  const seen = new Map<string, number>();
  for (const r of rows.filter(wellFormed)) seen.set(r[0], (seen.get(r[0]) ?? 0) + 1);

  return rows.map((r, i) => {
    const row = `row:${i + 1}`;
    if (r.length !== 5) return { key: row, status: 'invalid', errors: [`${r.length} fields, want 5`] };
    const [customer_id, first, , occ, note] = r.map((f) => f.trim());
    if (!wellFormed(r)) return { key: row, status: 'invalid', errors: ['bad customer_id'] };
    if (seen.get(r[0])! > 1) return { key: row, status: 'duplicate', errors: ['repeated customer_id'] };
    const new_user = NO_HISTORY.has(note.toLowerCase()) || /no (purchase|order|history)/i.test(note);
    if (!occ && !new_user) return { key: customer_id, status: 'invalid', errors: ['blank occasion'] };
    return { key: customer_id, status: 'ok', record: { customer_id, first_name: first || null, occasion: occ || null, new_user } };
  });
}
