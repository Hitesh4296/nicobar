// The search vocabulary (R141): families of real site tags, with counts over usable products. The prompt never sees a raw tag list, only these.
import type { Product } from '../../contracts/types.ts';

const PREFIXES: Record<string, string[]> = {
  occasion: ['Filteroccasion_'], category: ['Filtercategory_'], subcategory: ['Filtersubcategory_'], class: ['Filterclass_'], subclass: ['Filtersubclass_'],
  pattern: ['Filterpattern_'], sleeve: ['Filtersleeve_'], length: ['Filterlength_'], material: ['Material Group_'], collection: ['COLLECTION_'],
  campaign: ['Campaign_', 'campaign_'], looks: ['Festivelooks_'],
};
/** Operational tags. A family prefix never matches most of these; the list holds if a prefix is added. */
const DENY = [/^metafield_sync/, /^sync-product/, /Size_Guide/, /^Product_Variant/, /^apparel_product/, /^grouping_/, /^MATERIAL_/, /^-/, /^[a-z0-9]+(-[a-z0-9]+)+$/, /EOSS/i];
export const denied = (tag: string) => DENY.some((r) => r.test(tag));

/** One product's filter values. Colour, recipient and gift occasion come from fields the build already read. */
export function facetsOf(tags: string[], p: Pick<Product, 'colours'|'gift_recipient'|'gift_occasion'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tag of tags) {
    if (denied(tag)) continue;
    for (const [family, pre] of Object.entries(PREFIXES)) {
      const hit = pre.find((x) => tag.startsWith(x));
      const value = hit && tag.slice(hit.length).trim();
      if (value) out[family] = [...new Set([...(out[family] ?? []), value])];
    }
  }
  for (const [family, vals] of [['colour', p.colours], ['recipient', p.gift_recipient], ['gift_occasion', p.gift_occasion]] as const) if (vals.length) out[family] = [...new Set(vals)];
  return out;
}

export type Vocabulary = Record<string, { value: string; count: number }[]>;

export function vocabularyOf(usable: Pick<Product, 'facets'>[]): Vocabulary {
  const n = new Map<string, Map<string, number>>();
  for (const p of usable) for (const [f, vals] of Object.entries(p.facets ?? {})) {
    const m = n.get(f) ?? new Map<string, number>();
    n.set(f, m);
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return Object.fromEntries([...n].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([f, m]) => [f, [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))]));
}
