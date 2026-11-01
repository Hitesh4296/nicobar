import quotes from '../../../config/quotes.json' with { type: 'json' };
import type { BrandLine, Catalog, Envelope, ExpandedDraft, Plan, Product } from '../../contracts/types.ts';
import { brandFoot, brandHead, C, esc, firstImage, FONT_DISPLAY, FONT_SANS, LANDING_HREF } from '../../ui/nb.ts';

const TOKEN = /\{(p[1-6])\}/g;
const SHOWN = ['p1', 'p2', 'p3'];

/** Code's line, never the model's (R125, R128): verbatim, with its source, outside `fields`, so no word limit or judge counts it. Plain text, so X1 to X4 are untouched. */
export const brandLine = (key: string | null): BrandLine => {
  const { default: fallback, keys, lines } = quotes.brand_lines as { default: string; keys: Record<string, string>; lines: BrandLine[] };
  return lines.find((l) => l.id === ((key && keys[key]) || fallback))!;
};

/** Copy to images, no schema change: first paragraph with no token opens; a token's paragraph goes with its lowest shown pick; the rest joins the opening. */
export function pairBody(raw: string, shown: string[]): { opening: string[]; slots: Record<string, string[]> } {
  const paragraphs = raw.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  const first = paragraphs.find((t) => !t.match(TOKEN));
  const slots: Record<string, string[]> = {};
  const rest: string[] = [];
  for (const t of paragraphs) {
    if (t === first) continue;
    const slot = [...t.matchAll(TOKEN)].map((m) => m[1]).sort().find((s) => shown.includes(s));
    if (slot) (slots[slot] ??= []).push(t); else rest.push(t);
  }
  return { opening: first ? [first, ...rest] : rest, slots };
}

/** The stored href holds neither origin nor id, so the approved hash needs neither. The serving route calls this after the hash check. */
export const landingLink = (html: string, url: string): string => html.replaceAll(`href="${LANDING_HREF}"`, `href="${esc(url)}"`);

/** Review only: the same button, dead, and saying why. Model text is escaped, so neither string can come from it. */
export const emailPreview = (html: string): string => html.replace(` href="${LANDING_HREF}"`, '')
  .replace('See your edit</a>', `See your edit</a><p style="margin:10px 0 0;font:400 12px/16px ${FONT_SANS};color:${C.inkSoft}">Live after release</p>`);

const CSS = `@media (max-width:480px){.stack{display:block!important;width:100%!important;padding:0 0 28px!important}.pad{padding-left:24px!important;padding-right:24px!important}
.cards{padding:0 24px 8px!important}.lead,.line{font-size:26px!important;line-height:34px!important}}`;

const mailImg = (p: Product, slot: string, px: number, h: number) => {
  const img = firstImage(p);
  if (!img) return '';
  const src = new URL(img.src);
  src.searchParams.set('width', String(px * 2));
  src.searchParams.set('height', String(h * 2));
  src.searchParams.set('crop', 'center');
  return `<a data-slot="${slot}" href="${esc(p.url)}"><img data-slot="${slot}" src="${esc(src)}" alt="${esc(p.title)}" width="${px}" height="${h}" style="display:block;width:100%;height:auto;border:0"></a>`;
};

/** Fixed template, board A · The letter. Every title, image and link comes from the snapshot; no price. */
export function renderEmail(d: ExpandedDraft, cat: Catalog, envelope: Envelope, who?: Pick<Plan, 'display_name' | 'occasion'>, landing = false): string {
  const field = (name: string) => d.fields.find((f) => f.name === name);
  const picks = new Map(envelope.picks.flatMap((p) => { const r = cat.rows.get(p.product_id); return r ? [[p.slot as string, r] as const] : []; }));
  const shown = SHOWN.filter((s) => picks.has(s));
  const { opening, slots } = pairBody(field('body')?.raw ?? '', shown);

  const title = (slot: string, p: Product) => `<a data-slot="${slot}" href="${esc(p.url)}" style="color:${C.ink};font-weight:500;text-decoration:none">${esc(p.title)}</a>`;
  const inline = (t: string) => t.split(/(\{p[1-6]\})/).map((piece, i) => {
    if (i % 2 === 0) return esc(piece);
    const slot = piece.slice(1, -1), p = picks.get(slot);
    if (!p) return esc(piece);   // left for C2 to fail
    return shown.includes(slot) ? title(slot, p) : `<span style="font-weight:500">${esc(p.title)}</span>`;
  }).join('');
  /** A pick with no paragraph still shows its title. */
  const copy = (slot: string, p: Product, style: string) => (slots[slot] ?? [`{${slot}}`]).map((t) => `<p style="margin:0 0 12px;${style}">${inline(t)}</p>`).join('');

  const hero = picks.get('p1');
  const [lead, ...more] = opening;
  const bodyStyle = `font:400 16px/26px ${FONT_SANS};color:${C.ink}`;
  const openingHtml = (lead ? `<p class="lead" style="margin:0 0 16px;font:400 30px/40px ${FONT_DISPLAY};color:${C.ink}">${inline(lead)}</p>` : '')
    + more.map((t) => `<p style="margin:0 0 12px;${bodyStyle}">${inline(t)}</p>`).join('');
  const cards = ['p2', 'p3'].flatMap((slot) => {
    const p = picks.get(slot);
    return p ? [`<td class="stack" width="50%" valign="top" style="padding:0 6px">${mailImg(p, slot, 270, 338)}<div style="height:12px;line-height:12px;font-size:0">&nbsp;</div>${copy(slot, p, `font:400 14px/22px ${FONT_SANS};color:${C.inkSoft}`)}</td>`] : [];
  }).join('');
  const line = brandLine(envelope.occasion_key);
  const source = line.source.replace(/ footer$/, '');
  const button = landing ? `<tr><td align="center" style="padding:16px 24px 48px"><a data-landing href="${LANDING_HREF}" style="display:inline-block;padding:16px 36px;background:${C.ink};color:${C.onDark};font:500 13px/18px ${FONT_SANS};letter-spacing:.16em;text-transform:uppercase;text-decoration:none">See your edit</a></td></tr>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(field('subject')?.expanded ?? '')}</title><style>${CSS}</style></head>`
    + `<body data-part="email" style="margin:0;padding:0;background:${C.paper}"><div style="display:none;max-height:0;overflow:hidden">${esc(field('preheader')?.expanded ?? '')}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.paper}">`
    + `<tr><td>${brandHead(who ?? { display_name: envelope.display_name, occasion: null })}</td></tr>`
    + (hero ? `<tr><td>${mailImg(hero, 'p1', 600, 640)}</td></tr>` : '')
    + `<tr><td class="pad" style="padding:40px 56px 24px">${openingHtml}${hero ? copy('p1', hero, bodyStyle) : ''}</td></tr>`
    + (cards ? `<tr><td class="cards" style="padding:0 18px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cards}</tr></table></td></tr>` : '')
    + button
    + `<tr><td class="pad" align="center" style="padding:48px 56px;background:${C.indigo}"><p class="line" data-brand-line="${line.id}" style="margin:0 0 12px;font:400 28px/36px ${FONT_DISPLAY};color:${C.onDark}">${esc(line.text)}</p>`
    + `<small style="font:400 12px/16px ${FONT_SANS};letter-spacing:.04em;color:${C.onDarkSoft}">From ${esc(source)}</small></td></tr>`
    + `<tr><td>${brandFoot()}</td></tr></table></td></tr></table></body></html>`;
}
