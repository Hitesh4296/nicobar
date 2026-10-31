import type { Catalog, Envelope, ExpandedDraft, Format, ModelDraft, Slot } from '../../contracts/types.ts';

// Tolerant by design: a shape C1 will fail still needs a row at E3.
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function expand(model: ModelDraft, part: Format, envelope: Envelope, cat: Catalog): ExpandedDraft {
  const titles = new Map(envelope.picks.map((p) => [p.slot as string, cat.rows.get(p.product_id)?.title]));
  const fields: ExpandedDraft['fields'] = [];
  const add = (name: string, raw: unknown, slot_scope: Slot[] | null) => fields.push({ name, raw: str(raw), slot_scope,
    expanded: str(raw).replace(/\{(p[1-6])\}/g, (m, slot: string) => titles.get(slot) ?? m) });

  if (part === 'email') {
    for (const name of ['subject', 'preheader', 'body']) add(name, model[name], null);
    return { part, schema: 'email/v2', model, reader_text: fields[2].expanded, fields };
  }
  list(model.sections).forEach((s, i) => {
    const at = `sections[${i}]`;
    if (s?.type === 'hero') { add(`${at}.heading`, s.heading, [s.slot]); add(`${at}.line`, s.line, [s.slot]); }
    else if (s?.type === 'story') add(`${at}.text`, s.text, null);
    else if (s?.type === 'feature') add(`${at}.line`, s.line, [s.slot]);
    else if (s?.type === 'pairing') add(`${at}.line`, s.line, list(s.slots));
    else if (s?.type === 'product_grid') list(s.items).forEach((it, j) => add(`${at}.items[${j}].caption`, it?.caption, [it?.slot]));
    else if (s?.type === 'packing_list') list(s.items).forEach((it, j) => add(`${at}.items[${j}].note`, it?.note, [it?.slot]));
  });
  return { part, schema: 'landing/v3', model, fields, reader_text: fields.map((f) => f.expanded).filter(Boolean).join('\n\n') };
}
