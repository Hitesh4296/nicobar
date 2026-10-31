// Boards C1–C7, 3.1–3.3. Total over untrusted model output: what cannot render renders nothing, and validate names it.
import quotes from '../../../config/quotes.json' with { type: 'json' };
import type { Catalog, Envelope, ExpandedDraft, Plan, Product } from '../../contracts/types.ts';
import { customerPage, esc, eyebrow, pickImg, pickProduct } from '../../ui/nb.ts';

type Section = Record<string, unknown>;
type Who = Pick<Plan, 'display_name' | 'occasion'>;
const list = (v: unknown): Section[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Section[] : []);

const VIEW = (p: Product) => `<a class="nb-link" href="${esc(p.url)}"><span>View on nicobar.com</span></a>`;

/** `who` carries the occasion, which `Envelope` lacks. Without it the eyebrow is the name alone; see the handover. */
export function renderLanding(d: ExpandedDraft, cat: Catalog, envelope: Envelope, who?: Who): string {
  const expanded = new Map(d.fields.map((f) => [f.raw, f.expanded]));
  const text = (v: unknown) => esc(expanded.get(String(v ?? '')) ?? v);
  const product = (slot: unknown) => pickProduct(slot, envelope.picks, cat);
  const name = who ?? { display_name: envelope.display_name, occasion: null };
  let features = 0;
  let title = '';

  const card = (slot: unknown, caption?: unknown): string => {
    const p = product(slot);
    return p ? `<a class="nb-card" href="${esc(p.url)}">${pickImg(p, String(slot), 800)}<span class="nb-title">${esc(p.title)}</span>${caption === undefined ? '' : `<p class="nb-cap">${text(caption)}</p>`}</a>` : '';
  };

  const section = (s: Section): string => {
    switch (s.type) {
      case 'hero': {
        const p = product(s.slot);
        if (!p) return '';
        title ||= String(expanded.get(String(s.heading)) ?? s.heading);
        return `<section class="nb-hero nb-hero--split"><div>${pickImg(p, String(s.slot), 1200, false)}</div><div class="nb-hero-text">${eyebrow(name)}<h1 class="nb-h1">${text(s.heading)}</h1>`
          + `<p class="nb-lede">${text(s.line)}</p><p class="nb-cap">${esc(p.title)}</p>${VIEW(p)}</div></section>`;
      }
      case 'story': return `<section class="nb-section nb-text"><p>${text(s.text)}</p></section>`;
      case 'product_grid': {
        const items = list(s.items);
        return `<section class="nb-section"><div class="nb-products" style="--n:${items.length}">${items.map((i) => card(i.slot, i.caption)).join('')}</div></section>`;
      }
      case 'pairing': {
        const slots = Array.isArray(s.slots) ? s.slots : [];
        return `<section class="nb-section"><div class="nb-duo">${slots.map((x) => card(x)).join('')}</div><p class="nb-duo-line">${text(s.line)}</p></section>`;
      }
      case 'quote': {
        const q = quotes.quotes.find((x) => x.id === s.quote_id);
        return q ? `<section class="nb-band"><p>${esc(q.text)}</p><small>From ${esc(q.source)}</small></section>` : '';
      }
      case 'packing_list':
        return `<section class="nb-section nb-packing">${list(s.items).map((i) => {
          const p = product(i.slot);
          return p ? `<a class="nb-row" href="${esc(p.url)}">${pickImg(p, String(i.slot), 72)}<span><span class="nb-title">${esc(p.title)}</span><span class="nb-cap">${text(i.note)}</span></span></a>` : '';
        }).join('')}</section>`;
      case 'feature': {
        const p = product(s.slot);
        if (!p) return '';
        const reverse = features++ % 2 === 1 ? ' nb-split--reverse' : '';
        return `<section class="nb-section nb-split${reverse}"><div class="nb-split-text"><h2 class="nb-h2">${esc(p.title)}</h2><p class="nb-lede">${text(s.line)}</p>${VIEW(p)}</div>`
          + `<div class="nb-split-img">${pickImg(p, String(s.slot), 1000)}</div></section>`;
      }
      default: return '';
    }
  };

  const main = list(d.model.sections).map(section).join('');
  return customerPage(title || 'Nicobar', main);
}
