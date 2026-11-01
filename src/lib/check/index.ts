// The offline validator. The model proposes, this decides. No model call, no render call, no I/O.
// validate reads stored model text; validateRendered reads the pages. Both are pure and run again at E4 and E7.
// scripts/eval.ts mutates this file by exact string patches (PATCHES): reword a patched line there too.
import { Validator } from '@cfworker/json-schema';
import emailSchema from '../../../config/schemas/draft-email.v2.json' with { type: 'json' };
import landingSchema from '../../../config/schemas/draft-landing.v3.json' with { type: 'json' };
import occasionMap from '../../../config/occasion_map.json' with { type: 'json' };
import quotesFile from '../../../config/quotes.json' with { type: 'json' };
import { LISTS } from '../../contracts/lists.ts';
import { stem } from '../catalog/strip.ts';
import type { Catalog, CheckResult, Envelope, Format, Part, Plan, Product, RenderedJson, Rules, Slot } from '../../contracts/types.ts';

export const VALIDATOR_VERSION = 'check-v2';

/** Every string leaf the model writes as prose. test/node/check.test.ts walks the schemas against this (L-11). */
export const PROSE: Record<Format, string[]> = {
  email: ['subject', 'preheader', 'body'],
  landing_page: ['sections[hero].heading', 'sections[hero].line', 'sections[story].text', 'sections[product_grid].items[].caption',
    'sections[pairing].line', 'sections[packing_list].items[].note', 'sections[feature].line'],
};

const TOKEN = /\{p([1-6])\}/g;
const SENTENCE = /(?<=[.?])\s+/;
const TITLE_MASK = 'Titlespan';
const fold = (t: string) => t.replace(/[‘’]/g, "'");
const slotMask = (t: string, mask: string) => t.replace(TOKEN, mask);
const tokensIn = (t: string) => [...t.matchAll(TOKEN)].map((m) => `p${m[1]}` as Slot);
const c0Mask = (t: string) => slotMask(t, LISTS.charset.token_mask);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (s: string) => new RegExp(`\\b${escapeRe(s).replace(/\s+/g, '\\s+')}\\b`, 'i');

const CHARSET = new Set(LISTS.charset.chars);
const inSet = (c: string) => CHARSET.has(c);
const SPACED = new RegExp(LISTS.charset.spaced_letter_re);
const C4 = LISTS.c4.patterns.map((p) => ({ id: p.id, group: p.group, re: new RegExp(p.re, LISTS.c4.flags) }));
const C5 = [new RegExp(LISTS.c5.url_or_domain, LISTS.c5.flags), new RegExp(LISTS.c5.digit_run, LISTS.c5.flags)];
const C8N: Record<string, RegExp[]> = Object.fromEntries(Object.entries(LISTS.c8n).map(([id, spans]) => [id, (spans as string[]).map(phrase)]));
// The head noun is the last word of a row's last span: travel shirt, drape kurta, ear cuffs. Plural either way.
const C8N_HEAD: Record<string, RegExp> = Object.fromEntries(Object.entries(LISTS.c8n).flatMap(([id, spans]) => {
  const last = (spans as string[]).at(-1)?.split(/\s+/).at(-1);
  return last ? [[id, new RegExp(`\\b${last.replace(/(?<!s)s$/, '')}(?:s|es)?\\b`, 'i')]] : [];
}));
// ponytail: each cue fires 0 times beside a head noun in the 8,938 raw bodies and the good drafts. Bare `last`, `again`, `still`, `second`, `already` and `you've` do not, so they stay out.
const PAST_CUE = /\blast (?:winter|summer|spring|autumn|monsoon|year|season|month|week|time|trip|holiday)\b|\bbefore(?=\s*(?:[,.?;:]|$))|\bpreviously\b|\byou had\b|\bhave been\b|\bwent with you\b|\byou (?:wore|bought|took|packed|carried|chose|picked|used|brought|landed|kept)\b/i;
const C8O = LISTS.c8o.names.map((n) => ({ n, re: phrase(fold(n)) }));
const ALLOW = LISTS.c8_allow.allow_title_case;
const DAYS = LISTS.c8_allow.c8d_allow.days_and_months;
// ponytail: season.json excludes Rakhi only; a second excluded festival adds its words here. Cases SEA1, SEA2.
const OUT_OF_SEASON = ['rakhi', 'raksha', 'bandhan'];
const OCCASION_WORDS = LISTS.c8o.names.flatMap((n) => fold(n).split(' ')).filter((w) => !OUT_OF_SEASON.includes(w));
const PER_ROW = LISTS.c8_allow.per_row as Record<string, string[]>;
const V7 = LISTS.c7_vocabulary;
const TERMS = new RegExp(`\\b(${[...V7.materials, ...V7.colours, ...V7.techniques].join('|')})\\b`, 'g');
const COUNT = new RegExp(V7.count_phrases.patterns.join('|'), 'g');
const NUMBERS = V7.count_phrases.number_words as Record<string, number>;
const WARNS = LISTS.warn.patterns.map((p) => ({ id: p.id, re: new RegExp(p.re, LISTS.warn.flags) }));

const wsCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
const tokCount = (t: string) => (t.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
const words = (t: string) => Math.max(wsCount(t), tokCount(t));

const validators = { email: new Validator(emailSchema as never, '2020-12', false), landing_page: new Validator(landingSchema as never, '2020-12', false) };

interface Field { name: string; raw: string; expanded: string; scope: Slot[] | null }
interface Ctx { part: Format; model: any; plan: Plan; slots: Slot[]; fields: Field[]; title: (s: Slot) => string; product: (s: Slot) => Product;
  ptext: string; words: Set<string>; allow: Set<string>; rules: RuleIndex }
type Fail = (code: string, field?: string, detail?: string) => void;
type Rule = [id: string, severity: CheckResult['severity'], run: (ctx: Ctx, fail: Fail) => void];

const expandText = (t: string, ctx: Ctx) => t.replace(TOKEN, (_, n) => ctx.title(`p${n}` as Slot));

/** Same names and scope as gen's expand, and tolerant nowhere: it runs only after C1 passed. */
function scan(model: any, part: Format): Omit<Field, 'expanded'>[] {
  const field = (name: string, raw: string, scope: Slot[] | null) => ({ name, raw, scope });
  if (part === 'email') return PROSE.email.map((k) => field(k, model[k], null));
  return (model.sections as any[]).flatMap((s, i) => {
    const at = `sections[${i}]`;
    switch (s.type) {
      case 'hero': return [field(`${at}.heading`, s.heading, [s.slot]), field(`${at}.line`, s.line, [s.slot])];
      case 'story': return [field(`${at}.text`, s.text, null)];
      case 'feature': return [field(`${at}.line`, s.line, [s.slot])];
      case 'pairing': return [field(`${at}.line`, s.line, s.slots)];
      case 'product_grid': return s.items.map((it: any, j: number) => field(`${at}.items[${j}].caption`, it.caption, [it.slot]));
      case 'packing_list': return s.items.map((it: any, j: number) => field(`${at}.items[${j}].note`, it.note, [it.slot]));
      default: return [];   // quote: no model text
    }
  });
}

const groundOf = (p: Product) => `${p.title} ${p.body_text_clean ?? ''} ${[...p.colours, ...p.variants.map((v) => v.option1 ?? '')].join(' ')}`.toLowerCase();

// ---- C8 rule index, compiled once per Rules ----
interface RuleIndex { cores: Map<string, Set<string>>; distinct: Set<string>; maxLen: number; nouns: Set<string>; handles: string[] }
const CORE_TOKEN = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|&/g;
const coreTokens = (t: string) => t.match(CORE_TOKEN) ?? [];
const indexes = new WeakMap<Rules, RuleIndex>();
function ruleIndex(r: Rules): RuleIndex {
  let ix = indexes.get(r);
  if (ix) return ix;
  const cores = new Map<string, Set<string>>();
  let maxLen = 0;
  for (const c of r.title_cores) {
    const t = coreTokens(c), low = t.join(' ').toLowerCase();
    maxLen = Math.max(maxLen, t.length);
    if (!cores.has(low)) cores.set(low, new Set());
    cores.get(low)!.add(t.join(' '));
  }
  // ponytail: handles under three words read as ordinary hyphenated English, so only longer ones count (spec_probe3 HANDLES)
  ix = { cores, maxLen, distinct: new Set(r.distinctive_cores.map((c) => coreTokens(c).join(' ').toLowerCase())), nouns: new Set(r.nouns),
    handles: r.handles.filter((h) => h.split('-').length >= 3) };
  indexes.set(r, ix);
  return ix;
}

const lowerAllowed = (t: string) => ALLOW.reduce((s, a) => s.replaceAll(a, a.toLowerCase()), t);

function namesProduct(text: string, ix: RuleIndex): string | null {
  const clean = lowerAllowed(text);
  const toks = coreTokens(clean), low = toks.map((t) => t.toLowerCase());
  for (let i = 0; i < toks.length; i++) for (let L = 2; L <= ix.maxLen && i + L <= toks.length; L++) {
    const key = low.slice(i, i + L).join(' '), exact = ix.cores.get(key);
    if (exact && (exact.has(toks.slice(i, i + L).join(' ')) || ix.distinct.has(key))) return toks.slice(i, i + L).join(' ');
  }
  for (const m of clean.matchAll(/(?:[A-Z][a-z']+\s+){1,4}[A-Z][a-z']+/g)) {
    if (ix.nouns.has(stem(m[0].split(/\s+/).at(-1)!.toLowerCase()))) return m[0];
  }
  return ix.handles.find((h) => text.includes(h)) ?? null;
}

/** Runs of 2+ mid-sentence capitalised tokens not found in the picks and not made of occasion or calendar words. */
function capitalRuns(t: string, ctx: Ctx, mask: string): string[] {
  const out: string[] = [];
  const grounded = (run: string[]) => {
    const low = run.map((w) => w.toLowerCase());
    return ctx.ptext.includes(low.join(' ')) || low.every((w) => ctx.allow.has(w));
  };
  for (const sent of lowerAllowed(fold(slotMask(t, mask))).split(SENTENCE)) {
    const tk = sent.match(/[A-Za-z']+/g) ?? [];
    for (let j = 0; j < tk.length;) {
      if (!/^[A-Z]/.test(tk[j]) || (j === 0 && tk[j] !== TITLE_MASK)) { j++; continue; }
      let k = j;
      while (k + 1 < tk.length && /^[A-Z]/.test(tk[k + 1])) k++;
      const run = tk.slice(j, k + 1);
      if (run.length >= 2 && !grounded(run)) out.push(run.join(' '));
      j = k + 1;
    }
  }
  return out;
}

// ---- the rules ----
const anyPart: Rule[] = [
  ['C2', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) {
      if (/[{}]/.test(f.raw.replace(TOKEN, ''))) fail('BAD_TOKEN', f.name);
      if (/[\p{L}\p{N}-]\{p[1-6]\}|\{p[1-6]\}[\p{L}\p{N}-]/u.test(f.raw)) fail('TOKEN_ADJACENT', f.name);
    }
    if (ctx.part !== 'email') return;
    const used = tokensIn(ctx.model.body).sort(), want = [...ctx.slots].sort();
    if (used.join() !== want.join()) fail('SLOT_SET', 'body', `${used} vs ${want}`);
    for (const k of ['subject', 'preheader']) if (tokensIn(ctx.model[k]).length) fail('TOKEN_PLACE', k);
  }],
  ['C0', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) {
      const masked = c0Mask(f.raw);
      const bad = [...masked].find((c) => !inSet(c));
      if (bad) fail('CHARSET', f.name, `U+${bad.codePointAt(0)!.toString(16)}`);
      if (SPACED.test(masked)) fail('SPACED_LETTERS', f.name);
    }
  }],
  ['C4', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) {
      const t = fold(slotMask(f.raw, 'slot'));
      for (const p of C4) if (p.re.test(t)) fail(p.group, f.name, p.id);
    }
    const subject = ctx.part === 'email' ? slotMask(ctx.model.subject, 'slot') : '';
    if ((subject.match(/\p{Lu}/gu) ?? []).length > 0.5 * Math.max(1, (subject.match(/\p{L}/gu) ?? []).length)) fail('SUBJECT_CAPITALS', 'subject');
  }],
  ['C5', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) for (const re of C5) if (re.test(fold(slotMask(f.raw, 'slot')))) fail('URL_OR_NUMBER', f.name);
  }],
  ['C6', 'hard', (ctx, fail) => {
    if (ctx.model.occasion_key !== ctx.plan.occasion_key) fail('OCCASION_KEY', 'occasion_key', `${ctx.model.occasion_key} vs ${ctx.plan.occasion_key}`);
  }],
  ['C7', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) for (const sent of f.raw.split(SENTENCE)) {
      const slots = f.scope ?? tokensIn(sent).filter((s) => ctx.slots.includes(s));
      const ground = (slots.length ? slots : ctx.slots).map((s) => groundOf(ctx.product(s))).join(' ');
      const text = fold(slotMask(sent, 'slot')).toLowerCase();
      for (const m of text.matchAll(TERMS)) if (!new RegExp(`\\b${escapeRe(m[1])}\\b`).test(ground)) fail('UNGROUNDED', f.name, m[1]);
      for (const m of text.matchAll(COUNT)) {
        const w = m[1] ?? m[2], value = /^\d+$/.test(w) ? Number(w) : NUMBERS[w];
        if (value === undefined) continue;
        if (m[2] && value === ctx.slots.length) continue;
        const alts = [String(value), ...Object.keys(NUMBERS).filter((k) => NUMBERS[k] === value)].join('|');
        const pat = m[1] ? `\\bsets? of (${alts})\\b` : `\\b(${alts})\\s+pieces?\\b`;
        if (!new RegExp(pat).test(ground)) fail('UNGROUNDED_COUNT', f.name, m[0]);
      }
    }
  }],
  ['C8', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) {
      const hit = namesProduct(fold(slotMask(f.raw, 'slot')), ctx.rules);
      if (hit) fail('NAMES_PRODUCT', f.name, hit);
    }
  }],
  ['C8n', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) for (const hit of c8nHits(f.raw, ctx.plan.customer_id)) fail('PAST_ITEM', f.name, hit);
  }],
  ['C8o', 'hard', (ctx, fail) => {
    if (ctx.plan.occasion !== null) return;
    for (const f of ctx.fields) for (const { n, re } of C8O) if (re.test(fold(f.raw))) fail('OCCASION_NAME', f.name, n);
  }],
  ['C8d', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) for (const run of capitalRuns(f.raw, ctx, 'slot')) fail('CAPITAL_RUN', f.name, run);
  }],
  ['C8c', 'warn', (ctx, fail) => {
    for (const f of ctx.fields) for (const sent of lowerAllowed(fold(slotMask(f.raw, 'slot'))).split(SENTENCE)) {
      (sent.match(/[A-Za-z']+/g) ?? []).forEach((w, j) => { if (j > 0 && /^[A-Z]/.test(w) && !ctx.words.has(w.toLowerCase())) fail('CAPITAL', f.name, w); });
    }
  }],
  ...WARNS.map(({ id, re }): Rule => [id, 'warn', (ctx, fail) => {
    for (const f of ctx.fields) if (re.test(` ${fold(slotMask(f.raw, 'slot'))} `)) fail(id, f.name);
  }]),
  ['LONG_SENTENCE', 'warn', (ctx, fail) => {
    for (const f of ctx.fields) for (const s of f.expanded.split(SENTENCE)) if (words(s) > LISTS.warn.long_sentence_words) fail('LONG_SENTENCE', f.name);
  }],
  ['C8d-x', 'hard', (ctx, fail) => {
    for (const f of ctx.fields) for (const run of capitalRuns(f.raw, ctx, TITLE_MASK)) if (run.includes(TITLE_MASK)) fail('CAPITAL_RUN', f.name, run);
  }],
];

const quoteKeys = (id: string) => (quotesFile.quotes.find((q) => q.id === id)?.labels ?? [])
  .flatMap((l) => (occasionMap.quote_labels as Record<string, string[]>)[l] ?? []);
const groupOf = (plan: Plan, s: Slot) => plan.picks.find((p) => p.slot === s)?.group;
const shownSlots = (sections: any[]): Slot[] => sections.flatMap((s) => {
  if (s.type === 'hero' || s.type === 'feature') return [s.slot];
  if (s.type === 'pairing') return s.slots;
  if (s.type === 'product_grid' || s.type === 'packing_list') return s.items.map((it: any) => it.slot);
  return [];
});
const CAPS: Record<string, [number, number]> = { heading: [2, 8], story: [15, 50], caption: [4, 18], note: [3, 10], hero: [8, 25], pairing: [8, 30], feature: [12, 30] };

const landingOnly: Rule[] = [
  ['C2.L1', 'hard', (ctx, fail) => {
    const s = ctx.model.sections;
    if (s[0].type !== 'hero' || s.filter((x: any) => x.type === 'hero').length !== 1) fail('HERO');
  }],
  ['C2.L2', 'hard', (ctx, fail) => {
    const shown = shownSlots(ctx.model.sections).sort(), want = [...ctx.slots].sort();
    if (shown.join() !== want.join()) fail('SLOTS_SHOWN', 'sections', `${shown} vs ${want}`);
  }],
  ['C2.L3', 'hard', (ctx, fail) => {
    const seen = new Set<Slot>();
    for (const f of ctx.fields) for (const t of tokensIn(f.raw)) {
      if (seen.has(t)) fail('TOKEN_TWICE', f.name, t);
      seen.add(t);
      if (!ctx.slots.includes(t) || /\.(heading|caption|note)$/.test(f.name) || (f.scope && !f.scope.includes(t))) fail('TOKEN_PLACE', f.name, t);
    }
  }],
  ['C2.L4', 'hard', (ctx, fail) => {
    const types: string[] = ctx.model.sections.map((s: any) => s.type);
    const n = (t: string) => types.filter((x) => x === t).length;
    if (n('story') > 2 || n('quote') > 1 || n('packing_list') > 1 || n('feature') > 2) fail('SECTION_COUNT');
    const text = (t: string) => t === 'story' || t === 'quote';
    if (types.some((t, i) => i > 0 && text(t) && text(types[i - 1]))) fail('TEXT_ADJACENT');
  }],
  ['C2.L5', 'hard', (ctx, fail) => {
    for (const s of ctx.model.sections) {
      if (s.type !== 'quote') continue;
      const key = ctx.plan.occasion_key;
      if (key === null || !quoteKeys(s.quote_id).includes(key)) fail('QUOTE_FIT', 'sections', s.quote_id);
      if (s.quote_id === 'E6' && !ctx.plan.picks.some((p) => p.group === 'home')) fail('QUOTE_NEEDS_HOME', 'sections', s.quote_id);
    }
  }],
  ['C2.L6', 'hard', (ctx, fail) => {
    const types: string[] = ctx.model.sections.map((s: any) => s.type);
    const n = (t: string) => types.filter((x) => x === t).length;
    const shape = ctx.plan.shape;
    if ((shape === 'trip' && n('packing_list') !== 1) || (shape === 'gift' && n('feature') < 1) || (shape === 'home' && n('product_grid') < 1)
      || (shape === 'wedding' && n('pairing') < 1) || (shape === 'scene' && types[1] !== 'story')) fail('SHAPE', 'sections', shape ?? undefined);
  }],
  ['C2.L7', 'hard', (ctx, fail) => {
    for (const s of ctx.model.sections) {
      if (s.type !== 'pairing') continue;
      const [a, b] = s.slots.map((x: Slot) => groupOf(ctx.plan, x));
      if (a !== b || (ctx.plan.shape === 'home' && a !== 'home')) fail('PAIR_GROUP', 'sections', `${a} ${b}`);
    }
  }],
  ['C3.L', 'hard', (ctx, fail) => {
    const counted = ctx.fields.map((f) => f.expanded).join(' ');
    if (words(counted) > 120) fail('OVER_WORDS', 'sections', String(words(counted)));
    ctx.model.sections.forEach((s: any, i: number) => {
      const cap = (name: string, kind: string, t: string) => {
        const n = wsCount(t), [lo, hi] = CAPS[kind];
        if (n < lo || n > hi) fail('FIELD_WORDS', `sections[${i}].${name}`, `${n} not in ${lo}-${hi}`);
      };
      if (s.type === 'hero') { cap('heading', 'heading', s.heading); cap('line', 'hero', s.line); }
      if (s.type === 'story') cap('text', 'story', s.text);
      if (s.type === 'pairing') cap('line', 'pairing', s.line);
      if (s.type === 'feature') cap('line', 'feature', s.line);
      if (s.type === 'product_grid') s.items.forEach((it: any, j: number) => cap(`items[${j}].caption`, 'caption', it.caption));
      if (s.type === 'packing_list') s.items.forEach((it: any, j: number) => cap(`items[${j}].note`, 'note', it.note));
    });
  }],
];

const emailOnly: Rule[] = [
  ['C3', 'hard', (ctx, fail) => {
    const n = words(ctx.fields.find((f) => f.name === 'body')!.expanded);
    if (n > 120) fail('OVER_WORDS', 'body', String(n));
  }],
];

const partsOf = (plan: Plan): Format[] => (plan.format === 'both' ? ['email', 'landing_page'] : [plan.format]);

/** C1 is a draft-wide stop. It returns the failures, or the parsed draft. */
function c1(model_json: string, parts: Format[]): { failures: CheckResult[]; model: any } {
  const bad = (part: Format, code: string, detail?: string): CheckResult => ({ id: 'C1', part, severity: 'hard', pass: false, code, detail });
  let model: any;
  try { model = JSON.parse(model_json); } catch { return { failures: parts.map((p) => bad(p, 'NOT_JSON')), model: null }; }
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return { failures: parts.map((p) => bad(p, 'NOT_OBJECT')), model: null };
  if ('unparsed' in model) return { failures: parts.map((p) => bad(p, 'UNPARSED')), model };
  const failures: CheckResult[] = [];
  for (const k of Object.keys(model)) if (!(parts as string[]).includes(k)) failures.push(bad(parts[0], 'STRAY_KEY', k));
  for (const part of parts) {
    if (!(part in model)) { failures.push(bad(part, 'MISSING_PART')); continue; }
    const r = validators[part].validate(model[part]);
    if (!r.valid) failures.push(bad(part, 'SCHEMA', r.errors.slice(0, 3).map((e) => `${e.instanceLocation} ${e.error}`).join('; ')));
  }
  return { failures, model };
}

function context(part: Format, model: any, cat: Catalog, plan: Plan): Ctx {
  const all = plan.picks.map((p) => p.slot);
  const slots = part === 'email' ? all.slice(0, 3) : all;   // email is always p1 to p3, whatever N
  const product = (s: Slot) => {
    const id = plan.picks.find((p) => p.slot === s)?.product_id;
    const p = id === undefined ? undefined : cat.rows.get(id);
    if (!p) throw new Error(`no product for ${s}`);
    return p;
  };
  const title = (s: Slot) => (all.includes(s) ? product(s).title : '');
  const ptext = slots.map((s) => groundOf(product(s))).join(' ');
  const row = PER_ROW[plan.customer_id] ?? [];
  const ctx: Ctx = { part, model, plan, slots, title, product, ptext, fields: [], rules: ruleIndex(cat.rules),
    allow: new Set([...OCCASION_WORDS, ...DAYS, ...row]),
    words: new Set([...(ptext.match(/[a-z]+/g) ?? []), ...OCCASION_WORDS, ...row, 'nicobar', 'india', 'indian', 'slot']) };
  ctx.fields = scan(model, part).map((f) => ({ ...f, expanded: expandText(f.raw, ctx) }));
  return ctx;
}

/** Matching spans of the row's past item, then any sentence holding its head noun and a past-time cue. Raw model text. */
export function c8nHits(text: string, customer_id: string): string[] {
  const t = fold(text), head = C8N_HEAD[customer_id];
  const echoes = !head ? [] : t.split(SENTENCE).flatMap((s) => {
    const noun = head.exec(s), cue = PAST_CUE.exec(s);
    return noun && cue ? [`${noun[0]} + ${cue[0]}`] : [];
  });
  return [...(C8N[customer_id] ?? []).filter((re) => re.test(t)).map((re) => re.source), ...echoes];
}

export function validate(model_json: string, envelope: Envelope, cat: Catalog, plan: Plan): CheckResult[] {
  const parts = partsOf(plan);
  const { failures, model } = c1(model_json, parts);
  if (failures.length) return failures;
  const out: CheckResult[] = [];
  for (const part of parts) {
    out.push({ id: 'C1', part, severity: 'hard', pass: true });
    let ctx: Ctx;
    try { ctx = context(part, model[part], cat, plan); } catch (e) {
      out.push({ id: 'X1', part, severity: 'hard', pass: false, code: 'CHECK_ERROR', detail: String(e) });
      continue;
    }
    for (const [id, severity, run] of [...anyPart, ...(part === 'email' ? emailOnly : landingOnly)]) {
      const before = out.length;
      try {
        run(ctx, (code, field, detail) => out.push({ id, part, severity, pass: false, code, field, detail }));
      } catch (e) { out.push({ id, part, severity: 'hard', pass: false, code: 'CHECK_ERROR', detail: String(e) }); }
      if (out.length === before) out.push({ id, part, severity, pass: true });
    }
  }
  return out;
}

// ---- rendered: X1 to X4. A second export because validate has no page, and must run while a renderer is a stub ----
const HOST = 'cdn.shopify.com';
const STORE_PREFIX = '/s/files/1/0270/5129/4854/';

/** The image gate. Returns null, or the reason the URL is refused. `picks` is the pool: an image of any other product is refused. */
export function imageGate(url: string, picks: Product[]): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'IMG_SCHEME'; }
  if (u.protocol !== 'https:') return 'IMG_SCHEME';
  if (/^https:\/\/[^/]*[@:]/i.test(url)) return 'IMG_AUTHORITY';
  if (u.hostname !== HOST) return 'IMG_HOST';
  if (/\.\.|%2e/i.test(url)) return 'IMG_PATH';   // URL has already normalised u.pathname, so read the raw string
  if (!u.pathname.startsWith(STORE_PREFIX)) return 'IMG_OTHER_STORE';
  for (const [k, v] of u.searchParams) if (!['v', 'width', 'height', 'crop'].includes(k) || (k !== 'crop' && !/^\d+$/.test(v))) return 'IMG_QUERY';
  const canonical = `https://${HOST}${u.pathname}`;
  const pool = picks;
  return pool.some((p) => p.images.some((i) => i.src_canonical === canonical)) ? null : 'IMG_NOT_OF_SELECTED';
}

const attr = (tag: string, name: string) => {
  const v = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return v?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
};
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);

export function validateRendered(r: RenderedJson, envelope: Envelope, cat: Catalog, plan: Plan): CheckResult[] {
  const out: CheckResult[] = [];
  const picks = plan.picks.map((p) => ({ slot: p.slot, product: cat.rows.get(p.product_id) }));
  const known = picks.flatMap((p) => (p.product ? [p.product] : []));
  const moreProducts = (plan.more ?? []).flatMap((s) => s.product_ids).flatMap((id) => cat.rows.get(id) ?? []);
  const slotMap = (a: { slot: Slot; product_id: string }[]) => a.map((p) => `${p.slot}=${p.product_id}`).join();
  const mapOk = slotMap(envelope.picks) === slotMap(plan.picks) && known.length === plan.picks.length;
  for (const part of ['email', 'landing_page', 'catalog'] as Part[]) {
    const html = r[part as keyof RenderedJson];
    if (html === null) continue;
    const fails: Partial<Record<'X1' | 'X2' | 'X3' | 'X4', [string, string?][]>> = {};
    const fail = (id: 'X1' | 'X2' | 'X3' | 'X4', code: string, detail?: string) => (fails[id] ??= []).push([code, detail]);
    if (!mapOk) fail('X1', 'SLOT_MAP');
    const product = (s: string | undefined) => picks.find((p) => p.slot === s)?.product;
    const more = part === 'email' ? [] : moreProducts;   // catalog and landing only: email stays picks
    const pool = [...known, ...more];
    const shown = new Set<string>();
    for (const img of tags(html, 'img')) {
      const slot = attr(img, 'data-slot'), src = attr(img, 'src') ?? '', alt = attr(img, 'alt');
      const reason = imageGate(src, pool);
      if (reason) fail('X2', reason, src);
      if (!alt?.trim()) fail('X4', 'NO_ALT', slot);
      const moreId = attr(img, 'data-more'), m = more.find((p) => p.id === moreId);
      if (m) {
        if (!reason && imageGate(src, [m])) fail('X1', 'IMAGE_MISMATCH', moreId);
        if (alt?.trim() && alt !== m.title) fail('X1', 'TITLE_MISMATCH', moreId);
        continue;
      }
      const p = product(slot);
      if (!p) { fail('X1', 'UNKNOWN_SLOT', slot); continue; }
      shown.add(slot!);
      if (!reason && imageGate(src, [p])) fail('X1', 'IMAGE_MISMATCH', slot);
      if (alt?.trim() && alt !== p.title) fail('X1', 'TITLE_MISMATCH', slot);
    }
    const want = plan.picks.map((p) => p.slot).slice(0, part === 'email' ? 3 : undefined);
    if (want.some((s) => !shown.has(s))) fail('X1', 'SLOT_NOT_SHOWN', `${[...shown]}`);
    for (const a of tags(html, 'a')) {
      const href = attr(a, 'href') ?? '';
      let u: URL | null = null;
      try { u = new URL(href); } catch { /* refused below */ }
      const handle = u?.protocol === 'https:' && u.host === 'www.nicobar.com' && !u.username && !u.search ? /^\/products\/([^/]+)$/.exec(u.pathname)?.[1] : undefined;
      if (!pool.some((p) => p.handle === handle)) { fail('X3', 'HREF_NOT_OF_PICKS', href); continue; }
      const p = product(attr(a, 'data-slot'));   // ponytail: only `<img data-slot>` is contract; a link is tied to its card when the renderer marks it
      if (p && p.handle !== handle) fail('X1', 'LINK_MISMATCH', attr(a, 'data-slot'));
      const m = more.find((x) => x.id === attr(a, 'data-more'));
      if (m && m.handle !== handle) fail('X1', 'LINK_MISMATCH', attr(a, 'data-more'));
    }
    for (const id of ['X1', 'X2', 'X3', 'X4'] as const) {
      if (!fails[id]) out.push({ id, part, severity: 'hard', pass: true });
      else for (const [code, detail] of fails[id]!) out.push({ id, part, severity: 'hard', pass: false, code, detail });
    }
  }
  return out;
}
