// Agents screens, boards 2.5, 2.6, 2.7, 2.9, 2.10. Everything from a row or a body passes through esc.
import { NAV } from '../../contracts/nav.ts';
import { lineDiff } from '../../lib/config/index.ts';
import type { ConfigVersion, EvalValidity, FlagView, JevConfig, JevQuestion, PromptFiles, ValidationResult } from '../../contracts/types.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (v: unknown) => JSON.stringify(v).replaceAll('<', '\\u003c');

/** R109: the draft id comes as a second argument; without it the row is read-only. */
export function flagRow(f: FlagView, draft_id?: string): string {
  const d = f.dismissal;
  const head = `<strong>${esc(f.question)}</strong> ${f.flagged ? 'flagged' : 'clear'}`;
  if (d) return `<div class="flag">${head}<p>Dismissed by ${esc(d.actor_email)} at ${esc(d.at)}: ${esc(d.note)}</p></div>`;
  if (!f.flagged || !draft_id) return `<div class="flag">${head}</div>`;
  const action = `/api/drafts/${encodeURIComponent(draft_id)}/flags/${encodeURIComponent(f.question)}/dismiss`;
  return `<div class="flag">${head}<form method="post" action="${esc(action)}"><input name="note" required placeholder="Note why you are dismissing this flag" aria-label="Note">
<button>Dismiss with note</button></form><p class="fine">Logged with your name and note. Dismissing never changes checks or approval state.</p></div>`;
}

export function diffBlock(lines: { op: '=' | '+' | '-'; text: string }[]): string {
  const cls = { '=': 'same', '+': 'add', '-': 'del' };
  return `<pre class="code diff">${lines.map((l) => `<span class="${cls[l.op]}">${l.op === '=' ? ' ' : l.op} ${esc(l.text)}</span>`).join('\n')}</pre>`;
}

// ponytail: own shell because page's is unmerged; swap for page's at merge, the body stays.
const CSS = `:root{--paper:#F6F2ED;--ink:#1A1F28;--soft:#565E6A;--indigo:#263854;--on-dark:#F6F9FA;--on-dark-soft:#BFC8CC;--focus:#427596;--line:#D9D4CB;--pass:#2F6B4F;--fail:#A33A3A;--warn:#8A6210}
*{box-sizing:border-box}body{margin:0;display:flex;min-height:100vh;background:#fff;color:var(--ink);font:400 16px/26px Jost,system-ui,sans-serif}
.side{width:220px;flex:none;background:var(--ink);padding:24px 16px}.side b{display:block;padding:0 12px 24px;color:var(--on-dark);font:400 24px 'Bodoni Moda',serif}
.side a{display:block;padding:8px 12px;color:var(--on-dark-soft);text-decoration:none}.side a.on{background:var(--indigo);color:var(--on-dark)}
main{flex:1;min-width:0;padding:32px 40px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft)}
h1{font:400 40px/48px 'Bodoni Moda',serif;margin:4px 0 16px}h2{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft);font-weight:400;margin:32px 0 8px}
p{color:var(--soft);margin:8px 0}table{width:100%;border-collapse:collapse;font-size:14px;line-height:20px}th{text-align:left;font-weight:500;color:var(--soft);border-bottom:1px solid var(--ink);padding:8px 8px 8px 0}
td{border-bottom:1px solid var(--line);padding:8px 8px 8px 0;vertical-align:top}a{color:var(--focus)}
.code{background:var(--paper);padding:12px;font:13px/20px ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.del{color:var(--fail)}.add{color:var(--pass)}
.grid{display:grid;grid-template-columns:180px minmax(0,1fr) 260px;gap:24px}.files a{display:block;padding:6px 10px;color:var(--ink);text-decoration:none}.files a.on{background:var(--paper)}.files span{display:block;padding:6px 10px;color:var(--soft)}
textarea{width:100%;min-height:280px;padding:12px;border:1px solid var(--line);font:13px/20px ui-monospace,Menlo,monospace}textarea.short{min-height:72px;font:14px/20px Jost,system-ui,sans-serif}input{width:100%;padding:10px;border:1px solid var(--line);font:inherit;margin:8px 0}
button{padding:10px 18px;border:1px solid var(--ink);background:#fff;font:inherit;font-weight:500;cursor:pointer;margin:8px 8px 0 0}button.primary{background:var(--ink);color:var(--on-dark)}:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{border:1px solid var(--warn);padding:12px;margin:16px 0;font-size:14px;line-height:20px}.warn strong{color:var(--warn);font-weight:500;display:block}
.tag{border:1px solid var(--soft);padding:0 6px;font-size:12px}.tag.active{border-color:var(--pass);color:var(--pass)}.fine{font-size:14px}.flag{border:1px solid var(--warn);padding:12px;margin:8px 0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin:16px 0}.steps div{border:1px solid var(--line);padding:6px 10px;font-size:14px;line-height:20px;color:var(--soft)}.steps strong{display:block;color:var(--ink);font-weight:500}
.q{margin:16px 0;padding-top:8px;border-top:1px solid var(--line)}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{font-size:14px;font-weight:500;display:block;margin-top:8px}#err{color:var(--fail)}
@media(max-width:750px){body{display:block}.side{width:auto;padding:12px 16px}.side a{display:inline-block}main{padding:24px 16px}.grid,.two{grid-template-columns:1fr}h1{font-size:32px;line-height:40px}table{display:block;overflow-x:auto}}`;
const shell = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda&family=Jost:wght@300;400;500&display=swap"><style>${CSS}</style>
<nav class="side"><b>Nicobar</b>${NAV.map((n) => `<a href="${n.href}"${n.label === 'Agents' ? ' class="on"' : ''}>${n.label}</a>`).join('')}</nav><main>${body}</main></html>`;

const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const AGENTS = [['<strong>Writer</strong>', 'Sonnet 5.5', 'gen', 'Prefix, task, occasion, picks, quotes', 'JSON: email and landing_page, tokens only', 'One retry of the failed part, then CHECKS_FAILED'],
  ['<strong>Comparison writer</strong>', 'Haiku 5.5', 'Haiku run', 'Same prompt and picks', 'Same JSON', 'Reported only'],
  ['<strong>Draft judge</strong>', 'Jev 1.14.0', 'finish', 'Draft text, picks, occasion', '6 yes/no, 2 scores, with confidence', 'Fallback, logged, never fails a customer']];
const TOOLS = [['<strong>count_tokens</strong>', 'Anthropic API', 'est', 'The exact request', 'input_tokens', 'ESTIMATE_FAILED, skipped'],
  ['<strong>ingest, parse recs</strong>', 'Code', 'prep', 'TSV, recommendations file', 'Customer, picks', 'Row fails alone'],
  ['<strong>shape, group</strong>', 'Code', 'prep', 'Occasion, tags', 'trip, gift, home, wedding, scene, open', 'open'],
  ['<strong>admitAll, capRun</strong>', 'Code', 'admit', 'Estimates, config', 'admit, skip or stop, logged', 'OVER_CAP, RUN_CAP'],
  ['<strong>renderCatalog</strong>', 'Code', 'prep', 'Picks, snapshot', 'Catalog HTML', 'INVALID_PICK, $0'],
  ['<strong>validate</strong>', 'Code', 'finish, E2, E4, E7', 'Raw model JSON, plan', 'CheckResult per check', 'Hard failure blocks review'],
  ['<strong>expand, render</strong>', 'Code', 'finish', 'Tokens, snapshot', 'Email and landing HTML', 'X1–X4'],
  ['<strong>transition</strong>', 'Code', 'Routes', 'Draft id, hash, actor', 'EdgeResult: ok, or 409 with code', 'WRONG_STATE, HASH_MISMATCH'],
  ['<strong>freshness</strong>', 'Code', 'E7', 'Snapshot, picks', 'ok, SNAPSHOT_TOO_OLD or STALE_PICK', 'Publish refused']];
const WHO = ['Name', 'Kind', 'Runs at', 'Input', 'Output', 'On failure'];
const tag = (s: string) => `<span class="tag ${esc(s)}">${esc(s)}</span>`;
const versionRows = (vs: ConfigVersion[]) => table(['Version', 'Status', 'Note', 'By', 'Hash'], vs.map((v) => [`<a href="/review/agents/${encodeURIComponent(v.id)}">${esc(v.id)}</a>`, tag(v.status),
  esc(v.note), esc(v.created_by), `<code>${esc(v.sha256.slice(0, 12))}</code>`]));

export function agentsPage(versions: ConfigVersion[], validity: EvalValidity[]): string {
  const of = (k: string) => versions.filter((v) => v.kind === k);
  const sub = versions.length ? '' : '<p>No version yet. Run <code>npm run config seed</code> against the local Worker.</p>';
  const rows = validity.map((v) => [String(v.goal), esc(v.kind), esc(v.active_id), esc(v.stages.join(', ')), esc(v.run_ids.join(', ') || '—'),
    `<span class="${v.state === 'current' ? 'pass' : 'fail'}">${esc(v.state)}</span>`]);
  return shell('Agents', `<div class="eyebrow">Agents and tools</div><h1>Who does what</h1>
<p>No model has tool access. The Writer returns JSON, Jev returns a judgment, and code does everything else. Models can only fill fields that code checks, which limits what can be made up. A false claim in plain words is left to Jev and the reviewer.</p>
${sub}<h2>Writer prompt versions</h2>${versionRows(of('prompt'))}<h2>Jev versions</h2>${versionRows(of('jev'))}
<h2>Eval goals on the active versions</h2>${rows.length ? table(['Goal', 'Hangs on', 'Active', 'Stages', 'Runs', 'State'], rows) : '<p>Needs an active prompt and Jev.</p>'}
<p class="fine">Goals 1 to 9 depend on checks, lists and the stub, not on prompt text. A prompt change also voids <code>cap.json</code>'s S and E_out and <code>rungs.json</code>'s passed: re-run stage 0. The per-call token count at admit stays live. Nothing already approved changes.</p>
<h2>Agents</h2>${table(WHO, AGENTS)}<h2>Tools and code steps</h2>${table(WHO, TOOLS)}`);
}

const STEPS = [['1 Estimate', 'count_tokens'], ['2 Admit', 'Cap check'], ['3 Call', 'Messages'], ['4 Check raw', 'C1–C8n'], ['5 Expand', 'Tokens to titles'], ['6 Render', 'X1–X4'], ['7 Judge', 'J3 flags'], ['8 Review', 'In review']];
const FILES: [keyof PromptFiles, string][] = [['role', 'role'], ['voice_card', 'voice-card'], ['email', 'email'], ['landing', 'landing-v2'], ['task', 'task'], ['retry', 'retry']];

const SCRIPT = `const $=(s)=>document.querySelector(s);const data=$('#version')&&JSON.parse($('#version').textContent);
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
if(!r.ok){$('#err').textContent=(j.code||r.status)+(j.detail?': '+JSON.stringify(j.detail):'');return null}return j}
const put=(o,path,v)=>{const k=path.split('.');const last=k.pop();k.reduce((a,x)=>a[x],o)[last]=v};
const save=$('[data-save]');if(save)save.addEventListener('submit',async(e)=>{e.preventDefault();const content=structuredClone(data.content);
for(const f of save.querySelectorAll('[data-path]')){put(content,f.dataset.path,f.dataset.num?Number(f.value):f.dataset.lines?f.value.split('\\n').filter((l)=>l.trim()):f.value)}
const r=await post('/api/config',{kind:data.kind,parent_id:data.active,content,note:save.note.value});if(r)location.href='/review/agents/'+encodeURIComponent(r.id)});
const act=$('[data-activate]');if(act)act.addEventListener('click',async()=>{if(await post('/api/config/'+encodeURIComponent(data.id)+'/activate',{}))location.reload()});
const judge=$('[data-judge]');if(judge)judge.addEventListener('submit',async(e)=>{e.preventDefault();const r=await post('/api/config/'+encodeURIComponent(data.id)+'/judge',{draft_id:judge.draft.value});if(r)$('#judged').textContent=JSON.stringify(r,null,2)});`;

function checks(r: ValidationResult): string {
  if (r.ok) return `<table><tr><td>Validation</td><td class="pass">pass${r.prefix_bytes ? `, ${r.prefix_bytes} bytes` : ''}</td></tr></table>`;
  return `<table>${r.failures.map((f) => `<tr><td>${esc(f.rule)}${f.file ? ` · ${esc(f.file)}` : ''}</td><td class="fail">${esc(f.detail)}</td></tr>`).join('')}</table>`;
}
const noBase = (id: string | null) => (id ? `<p>Base ${esc(id)}: no base here.</p>` : '<p>First version, no base.</p>');

interface VersionView { v: ConfigVersion; baseId: string | null; base: ConfigVersion | null; file: string | null; result: ValidationResult; versions: ConfigVersion[]; deployed: boolean }

function actions(p: VersionView, draftStatus: boolean): string {
  if (p.deployed) return '<p class="fine">Read-only here.</p>';
  return `<input name="note" required placeholder="What changed, and why" aria-label="Note"><button class="primary">Save as a new version</button>
${draftStatus ? '<button type="button" data-activate>Activate</button>' : ''}<p id="err" role="alert"></p>`;
}

function promptBody(p: VersionView): string {
  const files = p.v.content as PromptFiles;
  const [key, name] = FILES.find(([k, n]) => k === p.file || n === p.file) ?? FILES[1];
  const diff = p.base ? diffBlock(lineDiff((p.base.content as PromptFiles)[key], files[key])) : noBase(p.baseId);
  const areas = FILES.map(([k, n]) => `<textarea data-path="${k}" aria-label="${n}"${k === key ? '' : ' hidden'}${p.deployed ? ' readonly' : ''}>${esc(files[k])}</textarea>`).join('');
  const v1 = p.versions.find((x) => x.id === 'v1');
  const sources = v1 && (v1.content as PromptFiles).voice_card !== files.voice_card ? '<p class="fine">Sources cover v1 only.</p>' : '';
  const id = encodeURIComponent(p.v.id);
  return `<div class="steps">${STEPS.map(([a, b]) => `<div><strong>${a}</strong>${b}</div>`).join('')}</div><div class="grid">
<div class="files"><h2>Foundation</h2>${FILES.map(([k, n]) => `<a href="?file=${n}"${k === key ? ' class="on"' : ''}>${n}</a>`).join('')}<h2>Locked</h2><span>Output schemas</span><span>Check lists</span><span>Shape rules</span></div>
<form${p.deployed ? '' : ' data-save'}><strong>${esc(name)}.md, ${esc(p.v.id)}</strong>${diff}${areas}${checks(p.result)}${actions(p, p.v.status === 'draft')}
<p class="fine">Test on one customer, up to $0.10 from the dev-calls line:</p><pre class="code">npm run config export ${esc(p.v.id)} --out out/prompt/${esc(p.v.id)} &amp;&amp; node scripts/draft-one.ts --prompt-dir out/prompt/${esc(p.v.id)} --only &lt;customer_id&gt; --limit-usd 0.10</pre>
<p class="fine">Never in the prompt, enforced by code: names, last names, past purchases, prices, tags, reason codes, recommendation scores, live data.</p></form>
<div><h2>Versions</h2>${table(['', ''], p.versions.filter((x) => x.kind === 'prompt').map((x) => [`<a href="/review/agents/${encodeURIComponent(x.id)}">${esc(x.id)}</a>`, tag(x.status)]))}
<div class="warn"><strong>Activating resets evals</strong>First-try, false-reject and voice results stop counting until a new run pins this version, and stage 0 must re-run. Offline eval re-runs at $0. After prompt freeze, activating means re-running F. New runs only.</div>${sources}
<p class="fine">Compare: <a href="/review/agents/${id}?against=${esc(encodeURIComponent(p.baseId ?? ''))}&amp;file=${esc(name)}">${esc(p.baseId ?? 'none')}</a></p></div></div>`;
}

function questionFields(k: string, q: JevQuestion, ro: string): string {
  const area = (path: string, label: string, val: string, lines = false) => `<label>${label}<textarea class="short" data-path="j3.${esc(k)}.${path}"${lines ? ' data-lines="1"' : ''}${ro}>${esc(val)}</textarea></label>`;
  const c = q.criteria;
  const fields = q.type === 'noul' && !Array.isArray(c)
    ? `<div class="two">${area('criteria.true.what', 'Yes means', c.true.what)}${area('criteria.false.what', 'No means', c.false.what)}${area('criteria.true.examples', 'Yes examples, one per line', c.true.examples.join('\n'), true)}${area('criteria.false.examples', 'No examples, one per line', c.false.examples.join('\n'), true)}</div>`
    : area('criteria', 'Anchors, low to high, one per line', (c as string[]).join('\n'), true);
  return `<div class="q" id="q-${esc(k)}"><strong>${esc(k)}</strong>${area('instructions', 'Question', q.instructions)}${fields}</div>`;
}

function jevBody(p: VersionView): string {
  const c = p.v.content as JevConfig;
  const ro = p.deployed ? ' readonly' : '';
  const rows = Object.entries(c.j3).map(([k, q]) => [`<strong>${esc(k)}</strong>`, q.type === 'noul' ? 'Yes/no' : 'Score', esc(q.instructions),
    q.type === 'noul' ? (q.bad ? 'yes' : 'no') : 'low', q.type === 'noul' ? `Flag at ${esc(c.flag_gate)}` : `Flag at ${esc(c.score_flag_confidence)} confidence`, 'Off, locked', `<a href="#q-${esc(k)}">Edit</a>`]);
  const num = (path: string, label: string, val: number) => `<label>${label}<input type="number" step="0.01" data-num="1" data-path="${path}" value="${esc(val)}"${ro}></label>`;
  const diff = p.base ? diffBlock(lineDiff(JSON.stringify(p.base.content, null, 2), JSON.stringify(c, null, 2))) : noBase(p.baseId);
  return `<p>Jev runs after code checks pass. It can only add a flag for the reviewer, and it never clears a check or changes the failure count.</p>
${table(['Question', 'Type', 'Asks', 'Bad side', 'Action', 'Hard act', ''], rows)}<h2>Against base</h2>${diff}<h2>Validation</h2>${checks(p.result)}
<h2>Edit</h2><form${p.deployed ? '' : ' data-save'}><div class="two">${num('flag_gate', 'Flag gate, 0.3 to 0.7', c.flag_gate)}${num('score_flag_confidence', 'Score confidence, 0.4 to 0.8', c.score_flag_confidence)}</div>
${Object.entries(c.j3).map(([k, q]) => questionFields(k, q, ro)).join('')}${actions(p, p.v.status === 'draft')}<p class="fine">Jev can add a flag. No edit here can clear a code check or change the failure count.</p></form>
${p.deployed ? '' : `<h2>Try on a stored draft</h2><form data-judge><input name="draft" required placeholder="Draft id" aria-label="Draft id"><button>Test this version</button><p class="fine">One Jev call, about $0.000554, logged and written to the ledger.</p></form><pre class="code" id="judged"></pre>`}
<div class="warn"><strong>Activating voids goals 14 and 15</strong>Until a run pins this version. Past runs keep the gate they ran with.</div>`;
}

export function versionPage(p: VersionView): string {
  const active = p.versions.find((x) => x.kind === p.v.kind && x.status === 'active');
  const data = { id: p.v.id, kind: p.v.kind, active: active?.id ?? null, content: p.v.content };
  const label = p.v.kind === 'prompt' ? 'Writer' : 'Draft judge';
  return shell(`Agents ${p.v.id}`, `<div class="eyebrow">Agents · ${label} · ${esc(p.v.id)} ${tag(p.v.status)}</div><h1>${p.v.kind === 'prompt' ? 'Writer prompt' : 'Jev questions and flags'}</h1>
<p class="fine">${esc(p.v.note)} · ${esc(p.v.created_by)} · ${esc(p.v.created_at)} · sha256 <code>${esc(p.v.sha256)}</code></p>
${p.v.kind === 'prompt' ? promptBody(p) : jevBody(p)}${p.deployed ? '' : `<script type="application/json" id="version">${json(data)}</script><script>${SCRIPT}</script>`}`);
}
