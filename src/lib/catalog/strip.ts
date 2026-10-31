// The strip, config/lists/strip.json. One function; the snapshot build uses it, and it runs in the Worker too, so no node import.
import { LISTS } from '../../contracts/lists.ts';

const S = LISTS.strip;
const BLOCK = new RegExp(S.split.block_re, S.split.block_flags + 'g');
const TAG = new RegExp(S.split.tag_re, 'g');
const SPACE = new RegExp(S.split.whitespace_re, 'g');
const SENTENCE = new RegExp(S.split.sentence_re);
const CP1252 = new RegExp(`[${Object.keys(S.cp1252).map((c) => `\\u${c}`).join('')}]`, 'g');
const cp1252 = S.cp1252 as Record<string, string>;
const FOLD = /[’‘]/g;
const step = (i: number) => S.drop_steps[i] as { re: string; flags: string };
const X1 = new RegExp(step(0).re, step(0).flags);
const DIM = new RegExp(step(1).re, step(1).flags);
const C4 = LISTS.c4.patterns.map((p) => new RegExp(p.re, LISTS.c4.flags));
const C5 = [new RegExp(LISTS.c5.url_or_domain, LISTS.c5.flags), new RegExp(LISTS.c5.digit_run, LISTS.c5.flags)];
const CHARS = new Set(LISTS.charset.chars);
const SPACED = new RegExp(LISTS.charset.spaced_letter_re);
const count = S.drop_steps[5] as unknown as { re: string; flags: string; number_words: Record<string, number> };
const COUNT = new RegExp(count.re, count.flags + 'g');
// ponytail: the whole 2026-10-29 pull has only &amp;. Unknown entities stay, and C5 or C0 then drops the unit.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const counts = (t: string) => [...t.matchAll(COUNT)].map((m) => { const w = (m[1] ?? m[2]).toLowerCase(); return count.number_words[w] ?? Number(w); });

/** The class-noun stem; rules.json `nouns` holds these, so C8 must stem with this. */
export const stem = (w: string) => w.toLowerCase().replace(/(es|s)$/, '');

/** Passes C0: every character is in the set, and no spaced letters. */
export const passesC0 = (t: string) => [...t].every((c) => CHARS.has(c)) && !SPACED.test(t);
export const passesC4 = (t: string) => { const f = t.replace(FOLD, "'"); return !C4.some((r) => r.test(f)); };
export const passesC5 = (t: string) => { const f = t.replace(FOLD, "'"); return !C5.some((r) => r.test(f)); };

function units(html: string): string[] {
  const text = html.replace(BLOCK, '\n').replace(TAG, ' ').replace(/&(#39|[a-z]+);/g, (m, e: string) => ENTITY[e] ?? m);
  return text.split('\n').flatMap((b) => {
    const block = b.replace(CP1252, (c) => cp1252[c.charCodeAt(0).toString(16).padStart(4, '0')]).replace(SPACE, ' ').trim();
    return block ? block.split(SENTENCE).filter(Boolean) : [];
  });
}

export function stripBody(html: string | null, title: string): string {
  const stated = counts(title);
  const keep = (u: string) => {
    const f = u.replace(FOLD, "'");
    if (X1.test(f) || DIM.test(f) || !passesC4(u) || !passesC5(u) || !passesC0(u)) return false;
    return !(stated.length && counts(f).some((n) => !stated.includes(n)));
  };
  return units(html ?? '').filter(keep).join(' ');
}
