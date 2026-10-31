// Customer pages: `.nb` tokens (boards A1–A5) and the page shell (E3). Code owns all of it; the model reaches none of it.
import type { Catalog, Image, Plan, Product } from '../contracts/types.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

// Stand-in stacks, no font load: Nicobar's fonts are unlicensed and BRAND_FONT stays off (A2). Hairlines need a display face, so Didot first.
export const TOKENS = `:root{--color-paper:#F5F2ED;--color-white:#FFFFFF;--color-ink:#1A1F28;--color-ink-soft:#565E6A;--color-indigo:#263B54;--color-line:#D9D4CB;
--color-on-dark:#F6F9FA;--color-on-dark-soft:#BFC8CC;--color-focus:#427596;--color-pass:#2F6B4F;--color-fail:#A33A3A;--color-warn:#8A6210;
--font-display:'Libre Caslon Display',Didot,'Bodoni 72','Playfair Display','Times New Roman',Georgia,serif;
--font-sans:Jost,'Avenir Next',Avenir,Futura,'Helvetica Neue',Arial,sans-serif;--container-page:1200px;--container-text:680px;--gutter:16px;--section:64px}
@media (min-width:750px){:root{--gutter:24px;--section:96px}}
@media (min-width:1200px){:root{--gutter:64px}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0}
img{display:block;max-width:100%;height:auto}
a:focus-visible,button:focus-visible,summary:focus-visible,textarea:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}`;

const NB_CSS = `${TOKENS}
body.nb{background:var(--color-paper);color:var(--color-ink);font:400 16px/26px var(--font-sans);-webkit-font-smoothing:antialiased}
.nb a{color:inherit;text-decoration:none}
.nb-head{display:flex;align-items:center;justify-content:space-between;min-height:72px;padding:0 var(--gutter);border-bottom:1px solid var(--color-line)}
.nb-mark{font:500 22px/28px var(--font-sans);letter-spacing:.24em;text-transform:uppercase}
.nb-note,.nb-foot{font-size:14px;line-height:20px;color:var(--color-ink-soft)}
.nb-foot{display:flex;justify-content:space-between;gap:16px;margin-top:var(--section);padding:24px var(--gutter) 40px;border-top:1px solid var(--color-line)}
.nb-eyebrow{margin:0 0 16px;font:500 12px/16px var(--font-sans);letter-spacing:.16em;text-transform:uppercase;color:var(--color-ink-soft)}
.nb-h1{margin:0;font:400 64px/68px var(--font-display);letter-spacing:-.01em}
.nb-h2{margin:0;font:400 40px/46px var(--font-display);letter-spacing:-.01em}
.nb-lede{margin:16px 0 0;font-weight:300;font-size:20px;line-height:32px}
.nb-title{display:block;font-size:15px;line-height:23px;font-weight:500}
.nb-cap{margin:4px 0 0;font-size:14px;line-height:20px;color:var(--color-ink-soft)}
.nb-link{display:inline-flex;align-items:center;min-height:44px;font:500 13px/18px var(--font-sans);letter-spacing:.14em;text-transform:uppercase}
.nb-link span{border-bottom:1px solid currentColor;padding-bottom:2px}
.nb-section{max-width:var(--container-page);margin:var(--section) auto 0;padding:0 var(--gutter)}
.nb-hero--split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:center;gap:56px;max-width:1328px;margin:0 auto;padding-right:var(--gutter)}
.nb-hero--split img{width:100%;aspect-ratio:4/5;object-fit:cover}
.nb-text{max-width:calc(var(--container-text) + 2 * var(--gutter));text-align:center}
.nb-text p{margin:0;font:400 32px/44px var(--font-display)}
.nb-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:64px}
.nb-split--reverse .nb-split-img{order:-1}
.nb-split-img img{width:100%;aspect-ratio:4/5;object-fit:cover}
.nb-split--reverse .nb-split-img{justify-self:start;width:80%}
.nb-split:not(.nb-split--reverse) .nb-split-img{justify-self:end;width:80%}
.nb-card img,.nb-duo img{width:100%;aspect-ratio:3/4;object-fit:cover;margin-bottom:12px}
.nb-products{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:16px}
.nb-duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.nb-duo-line{margin:24px 0 0;max-width:var(--container-text);font-weight:300;font-size:20px;line-height:32px}
.nb-band{margin-top:var(--section);padding:96px var(--gutter);background:var(--color-ink);color:var(--color-on-dark);text-align:center}
.nb-band p{margin:0 auto;max-width:900px;font:400 44px/52px var(--font-display)}
.nb-band small{display:block;margin-top:16px;font-size:14px;line-height:20px;color:var(--color-on-dark-soft)}
.nb-packing{max-width:calc(var(--container-text) + 2 * var(--gutter))}
.nb-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:16px;align-items:center;min-height:106px;padding:8px 0;border-bottom:1px solid var(--color-line)}
.nb-row img{width:72px;height:90px;object-fit:cover}
.nb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 16px}
@media (min-width:750px) and (max-width:989px){.nb-products{grid-template-columns:repeat(min(var(--n),3),minmax(0,1fr))}.nb-h1{font-size:48px;line-height:52px}}
@media (max-width:749px){
.nb-head{justify-content:center;min-height:56px}.nb-note{display:none}
.nb-foot{margin-top:64px}
.nb-h1{font-size:40px;line-height:42px}.nb-h2{font:500 15px/23px var(--font-sans);letter-spacing:0}
.nb-lede{font-size:17px;line-height:26px}.nb-duo-line{font-size:17px;line-height:26px}
.nb-hero--split{display:block;padding:0}.nb-hero-text{padding:24px var(--gutter) 0}
.nb-text{text-align:left}.nb-text p{font-size:26px;line-height:34px}
.nb-split{display:flex;flex-direction:column;align-items:stretch;gap:0;padding:0}.nb-split .nb-split-img,.nb-split:not(.nb-split--reverse) .nb-split-img,.nb-split--reverse .nb-split-img{order:-1;width:100%}.nb-split-text{padding:16px var(--gutter) 0}
.nb-products,.nb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.nb-products .nb-card:nth-child(3):last-child{grid-column:1/-1}
.nb-band{padding:48px var(--gutter);text-align:left}.nb-band p{font-size:32px;line-height:38px}
}`;

export const NB_FOOT = `<footer class="nb-foot"><span>Nicobar</span><span>Every title, image and link comes from nicobar.com</span></footer>`;

export function customerPage(title: string, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
    + `<style>${NB_CSS}</style></head><body class="nb"><header class="nb-head"><span class="nb-mark">Nicobar</span><span class="nb-note">A note for you, not a public page</span></header>`
    + `<main>${main}</main>${NB_FOOT}</body></html>`;
}

/** C1: `For Aditi · Mother's birthday`; occasion alone with no name; nothing with neither. */
export function eyebrow(plan?: Pick<Plan, 'display_name' | 'occasion'>): string {
  const text = [plan?.display_name && `For ${plan.display_name}`, plan?.occasion].filter(Boolean).join(' · ');
  return text ? `<p class="nb-eyebrow">${esc(text)}</p>` : '';
}

const firstImage = (p: Product): Image | undefined => [...p.images].sort((a, b) => a.position - b.position)[0];

/**
 * The only image tag on a customer page. `data-slot` is imagePaths' contract; alt is the title (X4).
 * ponytail: width and height are the 4:5 ratio of 2,179 of 2,180 first images, because `Image` carries no snapshot size. Add when the type does.
 */
export function pickImg(p: Product, slot: string, px: number, lazy = true): string {
  const img = firstImage(p);
  if (!img) return '';
  const src = new URL(img.src);
  src.searchParams.set('width', String(px));
  return `<img data-slot="${esc(slot)}" src="${esc(src)}" alt="${esc(p.title)}" width="${px}" height="${Math.round(px * 1.25)}"${lazy ? ' loading="lazy"' : ''}>`;
}

export const pickProduct = (slot: unknown, picks: { slot: string; product_id: string }[], cat: Catalog): Product | undefined => {
  const id = picks.find((p) => p.slot === slot)?.product_id;
  return id ? cat.rows.get(id) : undefined;
};
