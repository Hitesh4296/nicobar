// What a Worker needs to hash and validate a version: 46 §13, R109. The fixture is for validatePrompt only and never reaches a request.
import emailSchema from '../../../config/schemas/draft-email.v2.json' with { type: 'json' };
import landingSchema from '../../../config/schemas/draft-landing.v3.json' with { type: 'json' };
import jevBase from '../../../config/jev.json' with { type: 'json' };
import type { Catalog, JevConfig, Pick, Plan, Product, Slot } from '../../contracts/types.ts';

export const BUNDLE: { schemas: object[]; jevBase: JevConfig } = { schemas: [emailSchema, landingSchema], jevBase: jevBase as unknown as JevConfig };
export const PROMPT_MIN_BYTES = 8000;   // [assume] until tally reads the cache minimum (46 §13)
export const PROMPT_MAX_BYTES = 18000;  // [assume]

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const product = (n: number): Product => ({ id: `fx${n}`, handle: `fx-${n}`, title: `Fixture piece ${n}`, url: `https://www.nicobar.com/products/fx-${n}`,
  body_text_clean: 'Fixture body.', category: [], subcategory: [], class: [], subclass: [], wear_occasion: [], gift_occasion: [], gift_recipient: [], line: [],
  room_or_use: [], collection: [], campaign: [], occasion_keys: [], prior_tags: [], material: null, material_group: null, colours: [], gender: null, design_group: null,
  badges: [], is_bestseller_gift: false, available: true, variants: [], images: [], excluded_reason: null, content_sha256: 'fx' });
const products = [1, 2, 3, 4].map(product);
export const FX_CAT: Catalog = { snapshot_id: 'fx', fetched_at: '2026-10-29T00:00:00Z', rows: new Map(products.map((p) => [p.id, p])), by_sku: new Map(), usable: products,
  rules: { title_cores: [], distinctive_cores: [], nouns: [], handles: products.map((p) => p.handle) } };
const picks = products.map((p, i): Pick => ({ slot: `p${i + 1}` as Slot, product_id: p.id, reason_code: 'OCCASION_MATCH', group: 'wear' }));
export const FX_PLAN: Plan = { run_id: 'fx', customer_id: 'fx-both', created_at: '2026-10-29T00:00:00Z',
  pinned: { snapshot_id: 'fx', customers_sha256: 'fx', recs_sha256: 'fx', shapes_sha256: 'fx', run_date: '2026-10-29', prompt_version: 'fx', voice_guide_version: 'fx',
    jev_model: 'fx', jev_config_version: 'fx', format: 'both' },
  display_name: null, occasion: 'Fixture occasion', occasion_key: null, shape: 'open', new_user: false, format: 'both', picks, signals: [], admission: null, outcome: { kind: 'ready' } };
