import type { Catalog, Envelope, ExpandedDraft, Product } from '../../contracts/types.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const INK = 'color:#2b2622;font-family:Georgia,serif';

const card = (slot: string, p: Product) => {
  const href = `https://www.nicobar.com/products/${esc(p.handle)}`;
  const img = [...p.images].sort((a, b) => a.position - b.position)[0];
  return `<td width="33%" valign="top" style="padding:8px">${img ? `<a href="${href}"><img data-slot="${slot}" src="${esc(img.src)}" alt="${esc(p.title)}" width="170" style="display:block;width:100%;height:auto;border:0"></a>` : ''}`
    + `<a href="${href}" style="${INK};font-size:13px;text-decoration:none">${esc(p.title)}</a></td>`;
};

/** Fixed template: subject, preheader, body, cards for p1 to p3. Every title, image and link comes from the snapshot; no price. */
export function renderEmail(d: ExpandedDraft, cat: Catalog, envelope: Envelope): string {
  const text = (name: string) => d.fields.find((f) => f.name === name)?.expanded ?? '';
  const paragraphs = text('body').split(/\n\s*\n/).map((t) => `<p style="${INK};font-size:16px;line-height:1.6;margin:0 0 16px">${esc(t.trim())}</p>`).join('');
  const cards = envelope.picks.filter((p) => ['p1', 'p2', 'p3'].includes(p.slot)).flatMap((p) => {
    const product = cat.rows.get(p.product_id);
    return product ? [card(p.slot, product)] : [];
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(text('subject'))}</title></head>`
    + `<body data-part="email" style="margin:0;background:#f6f1ea"><div style="display:none;max-height:0;overflow:hidden">${esc(text('preheader'))}</div>`
    + `<table role="presentation" align="center" width="600" style="max-width:100%;background:#fff;border-collapse:collapse"><tr><td style="padding:32px 24px">${paragraphs}</td></tr>`
    + `<tr><td style="padding:0 16px 24px"><table role="presentation" width="100%"><tr>${cards}</tr></table></td></tr></table></body></html>`;
}
