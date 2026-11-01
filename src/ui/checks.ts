// The one plain-word map for checks: name, why, what next. /review/:id and /review/evals both read it. Model text is escaped here, then marked.
import { LISTS } from '../contracts/lists.ts';
import type { CheckResult, ModelJson, Part } from '../contracts/types.ts';
import { esc } from './nb.ts';

type Plain = { why: string; next: string };
const REDO = 'This draft cannot go out as written. Rerun this customer, or reject it.';
const READ = 'Read the words in place. Approve if they still sound like Nicobar; reject with a note if not.';

export const CHECK_NAMES: Record<string, string> = {
  C0: 'Unusual characters', C1: 'Draft format', C2: 'Product placeholders', 'C2.L1': 'Page opening', 'C2.L2': 'Every product shown once', 'C2.L3': 'Product name placement',
  'C2.L4': 'Page sections', 'C2.L5': 'Quote fits the occasion', 'C2.L6': 'Page layout for the occasion', 'C2.L7': 'Paired products', C3: 'Email over 120 words', 'C3.L': 'Landing page over 120 words',
  C4: 'Discount or pressure language', C5: 'Link or long number', C6: 'Wrong occasion', C7: 'Claim not on the product page', C8: 'Names a product not chosen', C8c: 'Unknown capitalised word',
  C8d: 'Made-up name', 'C8d-x': 'Made-up name beside a product', C8n: 'Mentions a past purchase', C8o: 'Names an occasion the customer does not have', LONG_SENTENCE: 'Long sentence',
  OUR: 'Speaks as "our"', SOFT: 'Soft sales word', SPACED_DASH: 'Standalone dash', X1: 'Product card does not match', X2: 'Image not from nicobar.com', X3: 'Link not to a chosen product', X4: 'Image with no description',
};
export const checkName = (id: string) => CHECK_NAMES[id] ?? 'Unnamed check';

/** The summary rows on a draft. Every id in here is also in CHECK_NAMES. */
export const CHECK_GROUPS: [string, string[]][] = [['Made-up product', ['C2', 'C8', 'C8d', 'C8d-x']], ['Image on nicobar.com', ['X2']], ['Discount phrase', ['C4']], ['Under 120 words', ['C3', 'C3.L']], ['Past item not echoed', ['C8n']]];

export const WHY_OF: Record<string, Plain> = {
  C0: { why: 'The copy uses a character outside the set allowed in customer copy.', next: REDO },
  C1: { why: 'The model did not return a draft in the required format, so nothing else could be checked.', next: REDO },
  C2: { why: 'The email must carry each chosen product through its placeholder, exactly once and in the body.', next: REDO },
  'C2.L1': { why: 'The landing page must open with one hero section.', next: REDO },
  'C2.L2': { why: 'The landing page must show every chosen product exactly once.', next: REDO },
  'C2.L3': { why: 'A product name appears twice or in a place that may not hold one.', next: REDO },
  'C2.L4': { why: 'The page has too many sections of one type, or two text sections in a row.', next: REDO },
  'C2.L5': { why: 'The quote on the page does not fit this occasion.', next: REDO },
  'C2.L6': { why: 'The page lacks the section this kind of occasion needs.', next: REDO },
  'C2.L7': { why: 'A pairing puts together two products that do not belong to one group.', next: REDO },
  C3: { why: 'The email body is over the 120-word limit.', next: REDO },
  'C3.L': { why: 'The landing page copy is over the 120-word limit.', next: REDO },
  C4: { why: 'The copy uses discount or pressure language, which Nicobar copy never does.', next: REDO },
  C5: { why: 'The copy holds a link or a long number; links and prices come only from the catalogue.', next: REDO },
  C6: { why: 'The draft is written for a different occasion from the one planned for this customer.', next: REDO },
  C7: { why: 'The copy states a material, colour or technique the product page does not give.', next: 'Open the product page. If it is not there, the claim is invented: rerun this customer, or reject it.' },
  C8: { why: 'The copy names a real product that was not chosen for this customer.', next: REDO },
  C8c: { why: 'A capitalised word in the copy is not on any chosen product page, so it may be a made-up name.', next: 'Check the word against the chosen products. Reject with a note if it is a product or a claim.' },
  C8d: { why: 'The copy uses a capitalised name that no chosen product has, so it reads like a made-up product or collection.', next: REDO },
  'C8d-x': { why: 'A capitalised word sits against a product name and changes it into a product that does not exist.', next: REDO },
  C8n: { why: 'The copy brings up what this customer bought before, which should stay out of the draft.', next: REDO },
  C8o: { why: 'This customer has no occasion on file, so the copy may not name one.', next: REDO },
  LONG_SENTENCE: { why: 'This sentence is longer than the house limit and may read heavily.', next: READ },
  OUR: { why: 'The copy says "our", which speaks for the company and may lead to a claim about it.', next: READ },
  SOFT: { why: 'This is a soft sales word that Nicobar copy rarely uses.', next: READ },
  SPACED_DASH: { why: 'A dash stands alone between spaces, which reads as a typing habit and not as Nicobar copy.', next: READ },
  X1: { why: 'A product card on the rendered page does not match the chosen product.', next: REDO },
  X2: { why: 'This image is not one of the chosen products\' images on nicobar.com.', next: REDO },
  X3: { why: 'This link does not go to a chosen product on nicobar.com.', next: REDO },
  X4: { why: 'An image has no alt text.', next: REDO },
};

const WHY_CODE: Record<string, string> = {
  'C1:STRAY_KEY': 'The model returned a part that was not asked for.', 'C1:MISSING_PART': 'The model left out a part that was asked for.', 'C1:NOT_JSON': 'The model answer was not readable JSON.',
  'C1:SCHEMA': 'A part of the draft does not match the required shape.',
  'C0:SPACED_LETTERS': 'The copy spaces out letters, which is how a word gets past a word check.',
  'C3.L:FIELD_WORDS': 'One line on the page is outside the word range allowed for it.',
  'C4:price': 'The copy talks about price or value; Nicobar copy says nothing about money.', 'C4:percent-off': 'The copy offers a percentage off; there are no live markdowns.', 'C4:discount-words': 'The copy offers a discount; discount language is banned outright.',
  'C4:paraphrase': 'The copy says the price is low without using a discount word.', 'C4:urgency-scarcity': 'The copy puts pressure on the reader about stock or time; Nicobar copy never does.', 'C4:deadline': 'The copy sets a deadline to buy by; Nicobar copy never does.',
  'C4:hype': 'The copy uses hype words, which is not the quiet Nicobar voice.', 'C4:familiarity': 'The copy claims a past or familiar relationship with the reader.', 'C4:meta': 'The copy talks about itself as marketing.', 'C4:pronoun': 'The copy uses a pronoun Nicobar copy avoids.',
  'C4:solicitation': 'The copy asks the reader to do something for the brand.', 'C4:SUBJECT_CAPITALS': 'The subject line is more than half capital letters.',
  'C7:UNGROUNDED_COUNT': 'The copy states a quantity the product page does not give.',
  'X1:IMAGE_MISMATCH': 'The image belongs to a different product from the one on this card.', 'X1:TITLE_MISMATCH': 'The image description names a different product.', 'X1:LINK_MISMATCH': 'This card links to a different product.',
  'X1:SLOT_NOT_SHOWN': 'A chosen product is missing from the page.', 'X1:UNKNOWN_SLOT': 'The page shows a product that is not in the plan.', 'X1:SLOT_MAP': 'The products on the draft are not the products in the plan.', 'X1:CHECK_ERROR': 'A chosen product could not be read, so the checks could not finish.',
};

export const PART_NAME: Record<Part, string> = { email: 'the email', landing_page: 'the landing page', catalog: 'the catalog' };
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const failed = (cs: CheckResult[]) => cs.filter((c) => c.severity === 'hard' && !c.pass);

/** Counts checks, not rows: one check can fail on several sentences. */
export function stoppedLine(checks: CheckResult[]): string {
  const bad = failed(checks), n = new Set(bad.map((c) => c.id)).size;
  const parts = [...new Set(bad.map((c) => PART_NAME[c.part]))];
  return n ? `Stopped: ${n} check${n === 1 ? '' : 's'} failed on ${list(parts)}` : 'Stopped: this draft did not pass';
}

const fold = (t: string) => t.replace(/[‘’]/g, "'");   // one for one, so an index here is an index in the raw text
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN = '\\{p[1-6]\\}';
const SENTENCE = /(?<=[.?!])\s+|\n+/;
const masked = (t: string) => fold(t).replace(/\{p[1-6]\}/g, 'slot');

/** A word list becomes a search over raw text: the checks read `slot` or `Titlespan` where the raw text holds a token. */
const finder = (w: string, bounded: boolean) => {
  const body = w.trim().split(/\s+/).map((x) => escRe(fold(x)).replace(/\b(?:slot|Titlespan)\b/g, TOKEN)).join('[^\\p{L}\\p{N}]+');
  return new RegExp(bounded ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, 'giu');
};

/** Escapes first, marks second. `titles` puts product names back into the raw text, inside and outside a mark. */
export function highlight(raw: string, words: string[], titles = new Map<string, string>(), bounded = false): string {
  const show = (t: string) => esc(t.replace(/\{(p[1-6])\}/g, (m, s: string) => titles.get(s) ?? m));
  const text = fold(raw);
  const spans = words.filter(Boolean).flatMap((w) => [...text.matchAll(finder(w, bounded))].map((m) => [m.index, m.index + m[0].length] as [number, number]))
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let at = 0, out = '';
  for (const [a, b] of spans) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    out += `${show(raw.slice(at, from))}<mark>${show(raw.slice(from, b))}</mark>`;
    at = b;
  }
  return out + show(raw.slice(at));
}

const matches = (res: RegExp[], text: string) => res.flatMap((re) => [...text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))].map((m) => m[0].trim())).filter(Boolean);
const re = (s: string, flags: string) => new RegExp(s, flags);

/** The words of one sentence that fired this check, read from the check's own pattern or its detail. Never the rule id. */
function wordsIn(c: CheckResult, sentence: string): { words: string[]; bounded: boolean } {
  const d = c.detail ?? '';
  const m = masked(sentence);
  switch (c.id) {
    case 'C4': {
      if (c.code === 'SUBJECT_CAPITALS') return { words: [m], bounded: false };
      const p = LISTS.c4.patterns.find((x) => x.id === d);
      return { words: p ? matches([re(p.re, LISTS.c4.flags)], m) : [], bounded: false };
    }
    case 'C5': return { words: matches([re(LISTS.c5.url_or_domain, LISTS.c5.flags), re(LISTS.c5.digit_run, LISTS.c5.flags)], m), bounded: false };
    case 'C0': return { words: d.startsWith('U+') ? [String.fromCodePoint(parseInt(d.slice(2), 16))].filter((ch) => m.includes(ch)) : [], bounded: false };
    case 'C8n': {
      const ws = d.replace(/\\b/g, '').replace(/\\s\+/g, ' ').replace(/\\(.)/g, '$1').split(' + ');
      return { words: ws.every((w) => finder(w, true).test(fold(sentence))) ? ws : [], bounded: true };
    }
    case 'C7': case 'C8': case 'C8d': case 'C8d-x': case 'C8c': case 'C8o':
      return { words: finder(d, true).test(fold(sentence)) ? [d] : [], bounded: true };
  }
  const w = LISTS.warn.patterns.find((p) => p.id === c.id);
  return { words: w ? matches([re(w.re, LISTS.warn.flags)], ` ${m} `) : [], bounded: false };
}

function fieldText(c: CheckResult, model: ModelJson | null): string | null {
  const walk = (c.field ?? '').match(/[^.[\]]+/g) ?? [];
  const v = walk.reduce<unknown>((o, k) => (o as Record<string, unknown> | null | undefined)?.[k], model?.[c.part as 'email'] as unknown);
  return walk.length && typeof v === 'string' ? v : null;
}

const SHOWN_AS_IS = ['C2', 'C2.L3', 'C3.L', 'C0'];
const code = (s: string) => `<p><code>${esc(s)}</code></p>`;

export interface Explained { name: string; part: string; hard: boolean; html: string | null; why: string; next: string }

/** What failed and where, in words. `html` is null when there is no sentence to show, or when the stored draft no longer holds the words. */
export function explain(c: CheckResult, model: ModelJson | null, titles: Map<string, string>): Explained {
  const plain = WHY_OF[c.id] ?? { why: 'This check failed.', next: REDO };
  const count = /^\d+$/.test(c.detail ?? '') ? ` It has ${c.detail} words.` : c.code === 'FIELD_WORDS' ? ` It has ${c.detail?.replace(/ not in /, ' words; allowed: ')}.` : '';
  const why = (WHY_CODE[`${c.id}:${c.code}`]?.replace(/([^.])$/, '$1.') ?? plain.why) + count;
  const base = { name: checkName(c.id), part: PART_NAME[c.part], hard: c.severity === 'hard', why, next: c.severity === 'hard' ? plain.next : READ };
  const raw = fieldText(c, model);
  if (c.id === 'X2' || c.id === 'X3') return { ...base, html: c.detail ? code(c.detail) : null };
  if (c.id === 'X1' || c.id === 'X4') return { ...base, html: titles.has(c.detail ?? '') ? `<p>${esc(titles.get(c.detail!))}</p>` : null };
  if ((c.id === 'C1' && c.detail) || c.id === 'C6') return { ...base, html: c.detail ? code(c.detail) : null };
  if (raw === null) return { ...base, html: null };
  if (c.id === 'LONG_SENTENCE') {   // counted with product names in, so the longest sentence of the field is the one
    const s = raw.split(SENTENCE).reduce((a, b) => (b.length > a.length ? b : a), '');
    return { ...base, html: `<p>${highlight(s, [masked(s)], titles)}</p>` };
  }
  const found = raw.split(SENTENCE).flatMap((s) => {
    const { words, bounded } = wordsIn(c, s);
    return words.length ? [`<p>${highlight(s, words, titles, bounded)}</p>`] : [];
  });
  if (found.length) return { ...base, html: [...new Set(found)].join('') };
  return { ...base, html: SHOWN_AS_IS.includes(c.id) && c.code !== 'OVER_WORDS' ? `<p>${highlight(raw, [], titles)}</p>` : null };
}

/** One block per thing to fix: a check that fires twice on one sentence shows once. */
export function explainBlocks(checks: CheckResult[], model: ModelJson | null, titles: Map<string, string>): string {
  const blocks = checks.filter((c) => !c.pass).map((c) => {
    const e = explain(c, model, titles);
    const tag = e.hard ? '<span class="fail">Failed</span>' : '<span class="warn">To read</span>';
    return `<div class="flag"><strong>${esc(e.name)}</strong> · ${esc(e.part)} · ${tag}${e.html ?? ''}<p>${esc(e.why)}</p><p><b>What to do:</b> ${esc(e.next)}</p></div>`;
  });
  return [...new Set(blocks)].join('');
}

const JEV_WHY: Record<string, string> = { no_key: 'no Jev key was set', reserve: 'the Jev spend reserve was used up', config: 'the Jev settings could not be loaded', model_mismatch: 'Jev answered from a different model version', deadline: 'Jev did not answer in time',
  network: 'Jev could not be reached', bad_response: 'Jev gave an answer that could not be read' };
export const jevNotRun = (reason: string | null | undefined) => `Not run: ${(reason && JEV_WHY[reason]) ?? (reason ? `Jev did not answer (${reason})` : 'no Jev result is stored for this draft')}.`;

export const QUESTION_NAMES: Record<string, string> = { names_unselected_product: 'Mentions a product not chosen', discount: 'Suggests a discount', pressure: 'Pressures the reader', claims_company: 'Makes a claim about Nicobar',
  claims_customer: 'Claims something about the customer', scene: 'No concrete scene', specific: 'Not specific about the product', quiet: 'Not quiet in tone' };
