import type { Catalog, Envelope, ModelJson, Plan, RenderedJson } from '../../contracts/types.ts';
import { expand } from './expand.ts';
import { renderEmail } from './email.ts';
import { renderLanding } from './landing-v2.ts';
import { renderCatalog } from './catalog.ts';

export function renderAll(m: ModelJson, plan: Plan, envelope: Envelope, cat: Catalog): RenderedJson {
  const wantsEmail = plan.format !== 'landing_page';
  const wantsLanding = plan.format !== 'email';
  // A part missing from model_json (unparsed, C1 fails) stays null: E3 still needs a row to store.
  return {
    email: wantsEmail && m.email ? renderEmail(expand(m.email, 'email', envelope, cat), cat, envelope) : null,
    landing_page: wantsLanding && m.landing_page
      ? renderLanding(expand(m.landing_page, 'landing_page', envelope, cat), cat, envelope, plan) : null,
    catalog: renderCatalog(plan, cat),
  };
}

/**
 * Slot → canonical image path (no host, no query), read by freshness.
 * Renderers mark each pick's image `<img data-slot="p1" src="…">`; that attribute is the contract.
 * First sighting of a slot wins, in email, landing, catalog order.
 */
export function imagePaths(r: RenderedJson): Record<string, string> {
  const out: Record<string, string> = {};
  for (const html of [r.email, r.landing_page, r.catalog]) {
    for (const [tag] of (html ?? '').matchAll(/<img\b[^>]*>/gi)) {
      const slot = /\bdata-slot="(p[1-6])"/.exec(tag)?.[1];
      const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
      if (slot && src && !(slot in out)) out[slot] = new URL(src, 'https://cdn.shopify.com').pathname;
    }
  }
  return out;
}
