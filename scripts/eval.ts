// npm run eval: every offline case and mutant, $0. Writes reports/eval.json; exit 1 on any mismatch or surviving mutant.
// Cases come from test/cases/; the catalogue is the 50-row fixture plus rules from test/fixtures/rules.eval.json (or --rules <path>).
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NotBuilt } from '../src/contracts/codes.ts';
import type { Catalog, CheckResult, Envelope, Format, Group, ModelDraft, ModelJson, Plan, Product, RenderedJson, RunFormat, Rules, Shape, Slot } from '../src/contracts/types.ts';
import * as real from '../src/lib/check/index.ts';
import { renderAll } from '../src/lib/render/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
type Check = typeof real;
type Case = Record<string, any>;

export const CASE_FILES = ['checks', 'blind-drafts', 'image-gate-and-links', 'injection', 'layout'] as const;

export function evalCatalog(rulesPath = 'test/fixtures/rules.eval.json'): Catalog {
  const fx = json('test/fixtures/catalog.fixture.json');
  const r = json(rulesPath);
  const usable = fx.rows as Product[];
  const rules: Rules = { title_cores: r.title_cores, distinctive_cores: r.distinctive_cores, nouns: r.nouns, handles: r.handles };
  return { snapshot_id: fx.snapshot_id, fetched_at: fx.fetched_at, usable, rules, rows: new Map(usable.map((p) => [p.id, p])),
    by_sku: new Map(usable.flatMap((p) => p.variants.filter((v) => v.sku).map((v) => [v.sku as string, p.id] as [string, string]))) };
}

const PICKS: Record<string, { id: string; group: Group }> = json('test/cases/picks.json').picks;

export function planFor(c: Case, cat: Catalog): { plan: Plan; envelope: Envelope } {
  const format: RunFormat = c.format ?? 'email';
  const picks = (c.picks as string[]).map((h, i) => ({ slot: `p${i + 1}` as Slot, product_id: PICKS[h].id,
    reason_code: 'OCCASION_MATCH' as const, group: PICKS[h].group }));
  const occasion_key: string | null = c.plan_occasion_key ?? null;
  const shape: Shape | null = c.plan_shape ?? null;
  const customer_id: string = c.customer_id ?? 'case';
  const occasion: string | null = c.plan_occasion ?? null;
  const pinned = { snapshot_id: cat.snapshot_id, customers_sha256: 'x', recs_sha256: 'x', shapes_sha256: 'x', run_date: '2026-11-01',
    prompt_version: 'v1', voice_guide_version: 'v1', jev_model: 'x', jev_config_version: 'x', format };
  const plan: Plan = { run_id: 'eval', customer_id, created_at: 'x', pinned, display_name: null, occasion, occasion_key, shape,
    new_user: !!c.new_user, format, picks, signals: [], admission: null, outcome: { kind: 'ready' } };
  const envelope: Envelope = { customer_id, run_id: 'eval', format, picks: picks.map(({ slot, product_id }) => ({ slot, product_id })), occasion_key,
    shape, snapshot_id: cat.snapshot_id, snapshot_fetched_at: cat.fetched_at, model: 'x', setting: 'x', prompt_version: 'v1', voice_guide_version: 'v1',
    validator_version: real.VALIDATOR_VERSION, carried_from: null, carried_part: null, display_name: null } as Envelope;
  return { plan, envelope };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Stand-in until gen and page merge: only the attributes X1–X4 read. renderAll takes over by itself once it stops throwing NOT_BUILT. */
function referenceRender(m: ModelJson, plan: Plan, cat: Catalog): RenderedJson {
  const card = (s: Slot) => {
    const pid = plan.picks.find((p) => p.slot === s)!.product_id;
    const p = cat.rows.get(pid)!;
    return `<a data-slot="${s}" href="${esc(p.url)}"><img data-slot="${s}" src="${esc(p.images[0].src)}" alt="${esc(p.title)}">${esc(p.title)}</a>`;
  };
  const page = (part: Format | 'catalog', model?: ModelDraft) => {
    const slots = plan.picks.map((p) => p.slot).slice(0, part === 'email' ? 3 : undefined);
    return `<article data-part="${part}">${model ? `<p>${esc(JSON.stringify(model))}</p>` : ''}${slots.map(card).join('')}</article>`;
  };
  return { email: plan.format !== 'landing_page' ? page('email', m.email) : null,
    landing_page: plan.format !== 'email' ? page('landing_page', m.landing_page) : null, catalog: page('catalog') };
}

export type RenderMutant = 'M15' | 'M22' | null;

function render(m: ModelJson, plan: Plan, env: Envelope, cat: Catalog, mutant: RenderMutant): RenderedJson {
  let r: RenderedJson;
  try { r = renderAll(m, plan, env, cat); } catch (e) { if (!(e instanceof NotBuilt)) throw e; r = referenceRender(m, plan, cat); }
  const each = (f: (html: string) => string): RenderedJson => ({ email: r.email && f(r.email), landing_page: r.landing_page && f(r.landing_page), catalog: f(r.catalog) });
  if (mutant === 'M15') return each((h) => h + JSON.stringify(m.email ?? m.landing_page ?? '').replace(/\\"/g, '"'));   // model text reaches the page raw
  if (mutant === 'M22') return each((h) => swapImage(h, 'p1', imgSrc(h, 'p2')));                                    // p1 shows p2's image
  return r;
}

const imgTag = (h: string, slot: string) => {
  const m = new RegExp(`<img\\b[^>]*data-slot="${slot}"[^>]*>`).exec(h);
  if (!m) throw new Error(`no image for ${slot} in the rendered part`);
  return m[0];
};
const imgSrc = (h: string, slot: string) => /\bsrc="([^"]*)"/.exec(imgTag(h, slot))![1];
const swapImage = (h: string, slot: string, src: string) => { const t = imgTag(h, slot); return h.replace(t, t.replace(/\bsrc="[^"]*"/, `src="${src}"`)); };

/** Applies a case's tamper to the rendered part. Tampers are prose in the X cases, so each id is spelled out here. */
function tamper(r: RenderedJson, c: Case): RenderedJson {
  const part = (c.part ?? (c.format === 'email' ? 'email' : 'landing_page')) as keyof RenderedJson;
  let h = r[part] as string;
  if (c.tamper?.src) h = swapImage(h, c.slot, c.tamper.src);
  if (c.tamper?.alt !== undefined) { const t = imgTag(h, c.slot); h = h.replace(t, t.replace(/\balt="[^"]*"/, `alt="${c.tamper.alt}"`)); }
  if (c.id === 'X1-01') h = swapImage(h, 'p2', imgSrc(h, 'p1'));
  if (c.id === 'X3-01') h = h.replace(/href="[^"]*"/, 'href="https://www.nicobar.com/products/hornbill-shirt-indigo"');
  if (c.id === 'X3-02') h = h.replace(/href="https:\/\/www\.nicobar\.com\//, 'href="https://www.nicobar.com.evil.io/');
  return { ...r, [part]: h };
}

const hard = (rs: CheckResult[]) => [...new Set(rs.filter((r) => !r.pass && r.severity === 'hard').map((r) => r.id))].sort();
const warns = (rs: CheckResult[]) => [...new Set(rs.filter((r) => !r.pass && r.severity === 'warn').map((r) => r.id))].sort();

export interface Outcome { id: string; file: string; fired: string[]; warn: string[]; verdict: 'pass' | 'fail'; ok: boolean; why?: string }

function judge(expect: Case, fired: string[], warn: string[]): string | undefined {
  if (expect.verdict === 'pass' && fired.length) return `expected pass, fired ${fired}`;
  if (expect.verdict === 'fail' && !expect.fails_any.some((x: string) => fired.includes(x))) return `expected one of ${expect.fails_any}, fired ${fired}`;
  if (expect.verdict === 'any' && expect.fails_none_of.some((x: string) => fired.includes(x))) return `expected none of ${expect.fails_none_of}, fired ${fired}`;
  for (const w of expect.warn_includes ?? []) if (!warn.includes(w)) return `expected warn ${w}, got ${warn}`;
}

function runCase(c: Case, file: string, cat: Catalog, ck: Check, mutant: RenderMutant): Outcome | null {
  const finish = (rs: CheckResult[], expect: Case): Outcome => {
    const fired = hard(rs), warn = warns(rs), why = judge({ warn_includes: c.warn_includes, ...expect }, fired, warn);
    return { id: c.id, file, fired, warn, verdict: fired.length ? 'fail' : 'pass', ok: !why, why };
  };
  if (c.layer === 'strip' || ['request', 'data', 'spec', 'live'].includes(c.kind) || c.id === 'L-10') return null;   // owned elsewhere, see SKIPPED
  if (typeof c.url === 'string') {                                                                                   // X2 gate unit cases
    const reason = ck.imageGate(c.url, c.selected.map((h: string) => cat.rows.get(PICKS[h].id)!));
    const verdict = reason ? 'fail' : 'pass', ok = verdict === c.expect;
    return { id: c.id, file, fired: reason ? ['X2'] : [], warn: [], verdict, ok, why: ok ? undefined : `expected ${c.expect}, got ${reason}` };
  }
  const { plan, envelope } = planFor(c, cat);
  if (c.layer === 'rendered' || c.kind === 'render') {
    const expect = typeof c.expect === 'string' ? { verdict: c.expect, fails_any: [c.expect_check ?? 'X1'] } : c.expect;
    const model: ModelJson = c.draft ?? blindDraft(c.id) ?? goodDraft(c.customer_id) ?? {};
    const rendered = tamper(render(model, plan, envelope, cat, mutant), c);
    return finish(ck.validateRendered(rendered, envelope, cat, plan), expect);
  }
  return finish(ck.validate(JSON.stringify(c.draft), envelope, cat, plan), c.expect);
}

const blindDraft = (id: string): ModelJson | undefined => id === 'BL-D7-render'
  ? json('test/cases/blind-drafts.json').cases.find((c: Case) => c.id === 'BL-D7').draft : undefined;

// L-12 cases carry no draft: they tamper with a good page of the same customer and picks.
const goodDraft = (id?: string): ModelJson | undefined => json('test/cases/layout.json').cases.find((c: Case) => c.id === `GOOD-${id}`)?.draft;

export const SKIPPED = [
  { id: 'L-10', kind: 'render', held_by: 'render tests', why: 'the occasion eyebrow is drawn by the real renderLanding; runs under page tests 1 and 2' },
  { id: 'L-11', kind: 'spec', held_by: 'check tests', why: 'held by test/node/check.test.ts, a schema walk, and M21 here' },
  { id: 'L-13', kind: 'live', held_by: 'readiness', why: 'stage F, gate false' },
  { id: 'N-08', kind: 'request', held_by: 'request tests', why: 'buildRequest test' },
  { id: 'N-10', kind: 'request', held_by: 'request tests', why: 'buildRequest test' },
  { id: 'N-13', kind: 'data', held_by: 'build', why: 'build output' },
  { id: 'R1', kind: 'spec', held_by: 'readiness', why: 'readiness' },
  { id: "INJ-08'-strip", kind: 'strip', held_by: 'build', why: 'the strip rule, run by the build' },
];

export function runSuite(cat: Catalog, ck: Check = real, mutant: RenderMutant = null): Outcome[] {
  const out: Outcome[] = [];
  for (const f of CASE_FILES) for (const c of json(`test/cases/${f}.json`).cases as Case[]) {
    const r = runCase(c, f, cat, ck, mutant);
    if (r) out.push(r);
  }
  const fixtures = (name: string, expect: (d: Case) => Case) => {
    for (const d of json(`test/fixtures/drafts.${name}.json`).drafts as Case[]) {
      const r = runCase({ ...d, expect: expect(d) }, `drafts.${name}`, cat, ck, mutant);
      if (r) out.push(r);
    }
  };
  fixtures('good', () => ({ verdict: 'pass' }));
  fixtures('bad', (d) => ({ verdict: 'fail', fails_any: [d.fails_check] }));
  for (const row of json('test/cases/layout.json').c8n_rows.rows as Case[]) {
    const fired = ck.c8nHits(row.text, row.customer_id).length ? ['C8n'] : [];
    const verdict = fired.length ? 'fail' : 'pass', ok = verdict === row.expect.verdict;
    out.push({ id: row.id, file: 'c8n_rows', fired, warn: [], verdict, ok, why: ok ? undefined : `expected ${row.expect.verdict}` });
  }
  return out;
}

/** A mutant is a patch to src/lib/check/index.ts, so production code carries no switches. A patch that no longer applies fails the run. */
export const PATCHES: Record<string, [string, string][]> = {
  M01: [['const inSet = (c: string) => CHARSET.has(c);', "const inSet = (c: string) => CHARSET.has(c) || (c >= '\\u00c0' && c <= '\\u024f');"]],
  M02: [['const c0Mask = (t: string) => slotMask(t, LISTS.charset.token_mask);', 'const c0Mask = (t: string) => t;']],
  M03: [["const TITLE_MASK = 'Titlespan';", "const TITLE_MASK = 'slot';"]],
  M04: [["if (run.length >= 2 && !grounded(run)) out.push(run.join(' '));", "if (run.some((w, i) => i > 0 && !ctx.words.has(w.toLowerCase()) && !ctx.words.has(run[i - 1].toLowerCase()))) out.push(run.join(' '));"]],
  M05: [['for (const m of text.matchAll(COUNT)) {', 'for (const m of [] as RegExpExecArray[]) {']],
  M06: [['const pat = m[1] ? `\\\\bsets? of (${alts})\\\\b` : `\\\\b(${alts})\\\\s+pieces?\\\\b`;', 'const pat = `\\\\b(${alts})\\\\b`;']],
  M07: [['if (m[2] && value === ctx.slots.length) continue;', '']],
  M08: [['const words = (t: string) => Math.max(wsCount(t), tokCount(t));', 'const words = (t: string) => wsCount(t);']],
  M09: [['const words = (t: string) => Math.max(wsCount(t), tokCount(t));', 'const words = (t: string) => tokCount(t);']],
  M10: [['const expandText = (t: string, ctx: Ctx) => t.replace(TOKEN, (_, n) => ctx.title(`p${n}` as Slot));', "const expandText = (t: string, _ctx: Ctx) => t.replace(TOKEN, '');"]],
  M11: [['const fold = (t: string) => t.replace(/[\u2018\u2019]/g, "\'");', 'const fold = (t: string) => t;']],
  M12: [['const C4 = LISTS.c4.patterns.map(', "const C4 = LISTS.c4.patterns.filter((p) => p.group !== 'paraphrase').map("]],
  M13: [['const C4 = LISTS.c4.patterns.map((p) => ({ id: p.id, group: p.group, re: new RegExp(p.re, LISTS.c4.flags) }));',
    "const C4 = LISTS.c4.patterns.map((p) => ({ id: p.id, group: p.group, re: new RegExp(p.re.replace('(?<!no )', ''), LISTS.c4.flags) }));"]],
  M14: [['if (SPACED.test(masked)) fail(', 'if (masked === null) fail(']],
  M16: [['const pool = picks;', 'const pool: Product[] = (globalThis as any).__allProducts;']],
  M17: [['if (used.join() !== want.join()) fail(', 'if (!used.every((u) => want.includes(u))) fail(']],
  M18: [['const words = (t: string) => Math.max(wsCount(t), tokCount(t));', 'const words = (t: string) => Math.max(t.split(/\\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length, tokCount(t));']],
  M19: [['const counted = ctx.fields.map((f) => f.expanded).join(\' \');', "const counted = [...ctx.fields.map((f) => f.expanded), ...ctx.slots.map((s) => ctx.title(s))].join(' ');"]],
  M20: [['const ALLOW = LISTS.c8_allow.allow_title_case;', "const ALLOW = LISTS.c8_allow.allow_title_case.filter((a) => a !== 'Indian Ocean');"]],
  M21: [["case 'packing_list': return s.items.map((it: any, j: number) => field(`${at}.items[${j}].note`, it.note, [it.slot]));", "case 'packing_list': return [];"]],
};

export async function runMutants(cat: Catalog, base: Outcome[]) {
  const src = join(ROOT, 'src/lib/check/index.ts');
  const text = readFileSync(src, 'utf8');
  const baseline = new Map(base.map((o) => [`${o.file}:${o.id}`, o.verdict]));
  (globalThis as any).__allProducts = cat.usable;   // M16 only
  const rows = [];
  for (const m of json('test/cases/mutants.json').mutants as Case[]) {
    let outcomes: Outcome[];
    if (m.id === 'M15' || m.id === 'M22') outcomes = runSuite(cat, real, m.id);
    else {
      let patched = text;
      for (const [from, to] of PATCHES[m.id]) {
        if (!patched.includes(from)) throw new Error(`${m.id}: patch no longer applies: ${from}`);
        patched = patched.replace(from, to);
      }
      const tmp = join(ROOT, `src/lib/check/_mutant_${m.id}.ts`);
      writeFileSync(tmp, patched);
      try { outcomes = runSuite(cat, await import(pathToFileURL(tmp).href)); } finally { rmSync(tmp); }
    }
    const flips = outcomes.filter((o) => baseline.get(`${o.file}:${o.id}`) !== o.verdict).map((o) => o.id);
    rows.push({ id: m.id, rule_change: m.rule_change, killed: flips.length > 0, killed_by: [...new Set(flips)], listed_killed_by: m.killed_by });
  }
  return rows;
}

const NAMED: Record<string, string> = { made_up_product: 'a made-up product', image_not_on_nicobar: 'an image not on nicobar.com', discount_phrase: 'a discount phrase', body_over_120_words: 'a body over 120 words' };

async function main() {
  const at = process.argv.indexOf('--rules');
  const cat = evalCatalog(at > 0 ? process.argv[at + 1] : undefined);
  const outcomes = runSuite(cat);
  const mutants = await runMutants(cat, outcomes);
  const bad = json('test/fixtures/drafts.bad.json').drafts as Case[];
  const byId = new Map(outcomes.filter((o) => o.file === 'drafts.bad').map((o) => [o.id, o]));
  const gateFail = (json('test/cases/image-gate-and-links.json').cases as Case[]).filter((c) => typeof c.url === 'string' && c.expect === 'fail');
  const named = Object.entries(NAMED).map(([key, label]) => {
    const cases = bad.filter((d) => d.named_failure === key).map((d) => d.id);
    return key === 'image_not_on_nicobar'
      ? { key, label, cases: gateFail.map((c) => c.id), caught: gateFail.filter((c) => outcomes.find((o) => o.file === 'image-gate-and-links' && o.id === c.id)?.verdict === 'fail').length / gateFail.length }
      : { key, label, cases, caught: cases.filter((id) => byId.get(id)?.verdict === 'fail').length / (cases.length || 1) };
  });
  const by = (f: string) => outcomes.filter((o) => o.file === f);
  const gaps = (json('test/cases/checks.json').cases as Case[]).concat(json('test/cases/blind-drafts.json').cases, json('test/cases/layout.json').cases)
    .filter((c) => c.known_gap).map((c) => ({ id: c.id, known_gap: c.known_gap }));
  const refFired = new Map((json('test/cases/checks.json').cases as Case[]).concat(json('test/cases/blind-drafts.json').cases)
    .filter((c) => c.reference_fired).map((c) => [c.id, c.reference_fired as string[]]));
  const reference_diffs = outcomes.filter((o) => (o.file === 'checks' || o.file === 'blind-drafts') && refFired.has(o.id)
    && [...refFired.get(o.id)!].sort().join() !== o.fired.join()).map((o) => ({ id: o.id, reference: refFired.get(o.id), fired: o.fired }));
  const failed = outcomes.filter((o) => !o.ok);
  const survivors = mutants.filter((m) => !m.killed);
  const report = { validator_version: real.VALIDATOR_VERSION, snapshot_id: cat.snapshot_id, paid_calls: 0,
    totals: { cases: outcomes.length, ok: outcomes.length - failed.length, failed: failed.length, mutants: mutants.length, survivors: survivors.length },
    by_file: Object.fromEntries([...new Set(outcomes.map((o) => o.file))].map((f) => [f, { cases: by(f).length, ok: by(f).filter((o) => o.ok).length }])),
    named_failures: named, failures: failed, reference_diffs, known_gaps: gaps, skipped: SKIPPED,
    mutants: mutants.map(({ listed_killed_by: _, ...m }) => m), outcomes };
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, 'reports/eval.json'), JSON.stringify(report, null, 1) + '\n');
  console.log(JSON.stringify(report.totals));
  for (const f of failed) console.log(`FAIL ${f.file}:${f.id} ${f.why}`);
  for (const m of survivors) console.log(`SURVIVED ${m.id} ${m.rule_change}`);
  for (const d of reference_diffs) console.log(`diff ${d.id} reference=${d.reference} fired=${d.fired}`);
  process.exit(failed.length || survivors.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
