// Board E2. Pure, no model, no price, no reason code: those stay on the review page.
import type { Catalog, Plan } from '../../contracts/types.ts';
import { customerPage, esc, eyebrow, moreSections, pickImg } from '../../ui/nb.ts';

export function renderCatalog(plan: Plan, cat: Catalog): string {
  const cards = plan.picks.map((pick) => {
    const p = cat.rows.get(pick.product_id);
    return p ? `<a class="nb-card" data-slot="${esc(pick.slot)}" href="${esc(p.url)}">${pickImg(p, pick.slot, 800)}<span class="nb-title">${esc(p.title)}</span></a>` : '';
  }).join('');
  return customerPage('Nicobar', `<section class="nb-section">${eyebrow(plan)}<div class="nb-grid">${cards}</div></section>${moreSections(plan.more, cat)}`);
}

export interface Card { slot: string; href: string; src: string; title: string }

/** How many `more` cards the stored page holds. */
export const countMore = (html: string) => html.match(/<a class="nb-card" data-more=/g)?.length ?? 0;

const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);

/** Reads the stored catalog back, so the review page shows what was approved and never loads the 14 MB snapshot. */
export function readCards(html: string): Card[] {
  return [...html.matchAll(/<a class="nb-card"(?: data-slot="p[1-6]")? href="(https:\/\/www\.nicobar\.com\/[^"]*)"><img data-slot="(p[1-6])" src="(https:\/\/cdn\.shopify\.com\/[^"]*)" alt="([^"]*)"/g)]
    .map(([, href, slot, src, title]) => ({ slot, href: unesc(href), src: unesc(src), title: unesc(title) }));
}
