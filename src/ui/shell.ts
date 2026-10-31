// Platform shell, boards D1–D5, E3. `shell` is what `demo` and `agents` screens wrap themselves in; it renders `NAV`.
import { NAV } from '../contracts/nav.ts';
import { esc, TOKENS } from './nb.ts';

const CSS = `${TOKENS}
body.p{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;background:var(--color-white);color:var(--color-ink);font:400 15px/22px var(--font-sans);-webkit-font-smoothing:antialiased}
.p a{color:inherit}
.rail{background:var(--color-ink);color:var(--color-on-dark-soft);padding:24px 16px}
.rail b{display:block;margin:0 12px 32px;font:400 24px/32px var(--font-display);color:var(--color-on-dark)}
.rail a{display:flex;align-items:center;min-height:40px;padding:0 12px;margin-bottom:2px;text-decoration:none}
.rail a[aria-current]{background:var(--color-indigo);color:var(--color-on-dark);font-weight:500}
main{padding:32px 40px;min-width:0;animation:in 120ms ease-out}
@keyframes in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.eyebrow{margin:0 0 4px;font:500 12px/16px var(--font-sans);letter-spacing:.16em;text-transform:uppercase;color:var(--color-ink-soft)}
h1{margin:0;font:400 44px/48px var(--font-display);letter-spacing:-.01em}
h2{margin:32px 0 8px;font:500 12px/16px var(--font-sans);letter-spacing:.16em;text-transform:uppercase;color:var(--color-ink-soft)}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--color-line)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border:1px solid var(--color-ink);background:var(--color-white);color:var(--color-ink);font:500 15px/20px var(--font-sans);text-decoration:none;cursor:pointer;list-style:none}
.btn::-webkit-details-marker{display:none}
.btn:hover{background:var(--color-paper)}
.btn.primary{background:var(--color-ink);color:var(--color-white)}.btn.primary:hover{background:var(--color-indigo)}
.btn.danger{border-color:var(--color-fail);color:var(--color-fail)}
.btn.danger.go{background:var(--color-fail);color:var(--color-white)}
.btn.wide{display:flex;width:100%}
.actions{display:grid;gap:8px}
.actions form{margin:0}
textarea{width:100%;min-height:88px;margin:8px 0;padding:8px;border:1px solid var(--color-ink);border-radius:0;font:inherit}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;padding:16px 0;border-bottom:1px solid var(--color-line)}
.metrics span{display:block;color:var(--color-ink-soft)}
.metrics b{display:block;font:400 40px/46px var(--font-display);font-variant-numeric:tabular-nums}
.note{color:var(--color-ink-soft)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{padding:8px 16px 8px 0;text-align:left;font:500 13px/18px var(--font-sans);color:var(--color-ink-soft);border-bottom:1px solid var(--color-ink);white-space:nowrap}
td{padding:10px 16px 10px 0;border-bottom:1px solid var(--color-line);vertical-align:top}
td a{font-weight:500;color:var(--color-ink)}
.pass{color:var(--color-pass)}.fail{color:var(--color-fail)}.warn{color:var(--color-warn)}.soft{color:var(--color-ink-soft)}
.pill{display:inline-block;padding:1px 8px;border:1px solid var(--color-ink-soft);font:500 13px/20px var(--font-sans);color:var(--color-ink-soft);white-space:nowrap}
.pill.approved{border-color:var(--color-pass);color:var(--color-pass)}
.pill.released{border-color:var(--color-ink);color:var(--color-ink)}
.pill.rejected,.pill.failed{border-color:var(--color-fail);color:var(--color-fail)}
.pill.skipped{border-color:var(--color-warn);color:var(--color-warn)}
.banner{display:flex;gap:12px;margin-bottom:8px;padding:12px 16px;border:1px solid var(--color-ink-soft)}
.banner b{font-weight:500;color:var(--color-ink-soft)}
.banner.warn{border-color:var(--color-warn)}.banner.warn b{color:var(--color-warn)}
.banner.fail{border-color:var(--color-fail)}.banner.fail b{color:var(--color-fail)}
.card{padding:24px;border:1px solid var(--color-line);margin-top:16px}
.card h3{margin:0 0 4px;font:400 26px/32px var(--font-display)}
.runs{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 16px}
.draft{display:grid;grid-template-columns:minmax(0,1fr) 448px;gap:32px;margin-top:16px}
.tabs{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--color-line);margin-bottom:12px}
.tabs div{display:flex;gap:24px}
.tabs a{display:inline-flex;align-items:center;min-height:44px;color:var(--color-ink-soft);text-decoration:none;border-bottom:2px solid transparent}
.tabs a[aria-current]{color:var(--color-ink);font-weight:500;border-color:var(--color-ink)}
iframe{display:block;height:760px;border:1px solid var(--color-line);background:var(--color-paper);max-width:none}
.step{display:flex;flex-wrap:wrap;gap:16px;margin:12px 0}
.step .done{color:var(--color-pass)}.step .now{font-weight:500}.step .next{color:var(--color-ink-soft)}.step .bad{font-weight:500;color:var(--color-fail)}
.row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--color-line)}
.row span:last-child{font-weight:500;text-align:right;overflow-wrap:anywhere}
.pick{display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;align-items:center;padding:6px 0}
.pick img{width:40px;height:50px;object-fit:cover}
.pick a{display:block;font-size:13px;line-height:20px;color:var(--color-focus);text-decoration:none;overflow-wrap:anywhere}.pick a:hover{text-decoration:underline}
.pick small{color:var(--color-ink-soft)}
pre{margin:0;padding:12px;overflow:auto;max-height:320px;background:var(--color-paper);font:400 13px/20px ui-monospace,Menlo,monospace}
details>summary{cursor:pointer}
.flag{padding:8px 0;border-bottom:1px solid var(--color-line)}.flag p{margin:4px 0 0;color:var(--color-ink-soft)}.flag input{width:100%;min-height:44px;margin:8px 0;padding:8px;border:1px solid var(--color-ink);font:inherit}.flag button{min-height:44px;padding:0 18px;border:1px solid var(--color-ink);background:var(--color-white);font:500 15px/20px var(--font-sans);cursor:pointer}
.scrim{position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:rgba(245,242,237,.92);overflow:auto}
.dialog{width:560px;max-width:100%;padding:32px;background:var(--color-white);border:1px solid var(--color-ink)}
.dialog h3{margin:0 0 8px;font:400 32px/38px var(--font-display)}
.dialog .buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.dialog form{margin:0}
@media (max-width:989px){.draft{grid-template-columns:minmax(0,1fr)}}
@media (max-width:749px){body.p{display:block}main{padding:16px}.rail{display:flex;flex-wrap:wrap;gap:4px;padding:8px 16px}.rail b{width:100%;margin:0}h1{font-size:32px;line-height:38px}}`;

export function shell(title: string, active: string, body: string): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.href === active ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
    + `<style>${CSS}</style></head><body class="p"><nav class="rail" aria-label="Main"><b>Nicobar</b>${nav}</nav><main>${body}</main></body></html>`;
}

export const banner = (label: string, text: string, kind: '' | 'warn' | 'fail' = '') => `<p class="banner ${kind}"><b>${esc(label)}</b><span>${esc(text)}</span></p>`;
export const emptyCard = (title: string, text: string) => `<div class="card"><h3>${esc(title)}</h3><p class="note">${esc(text)}</p></div>`;
