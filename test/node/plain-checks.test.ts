// Every check a reviewer can see says what, where, why and what next, with no code to decode.
import { describe, expect, it } from 'vitest';
import { RULE_IDS } from '../../src/lib/check/index.ts';
import { CHECK_NAMES, explain, highlight, stoppedLine, WHY_OF } from '../../src/ui/checks.ts';
import { draftPage, type DraftView } from '../../src/ui/review.ts';
import type { CheckResult } from '../../src/contracts/types.ts';

const opts = { part: null, width: 1200, confirm: false, done: null, refused: null, prev: null, next: null };
function view(model: object, checks: CheckResult[], over: Partial<DraftView> = {}): DraftView {
  return { id: 'r:c01:v1', run_id: 'r', customer_id: 'c01', version: 1, format: 'both', status: 'failed', model: 'm', snapshot_id: 's', validator_version: 'v', envelope: {} as never,
    model_json: JSON.stringify(model), rendered: { email: '<p>x</p>', landing_page: '<p>x</p>', catalog: '' }, content_sha256: 'abcdef', hash_now: 'abcdef', checks, hard_failures: checks.filter((c) => !c.pass && c.severity === 'hard').length,
    approved_by: null, approved_at: null, ...over };
}
const page = (d: DraftView, flags = null as never, o = {}) => draftPage(d, null, flags, '', [], { ...opts, ...o });
const C7: CheckResult = { id: 'C7', part: 'landing_page', severity: 'hard', pass: false, code: 'UNGROUNDED_COUNT', field: 'sections[1].text', detail: 'one piece' };
const C4: CheckResult = { id: 'C4', part: 'email', severity: 'hard', pass: false, code: 'urgency-scarcity', field: 'body', detail: 'c4.032' };

describe('the shared name map', () => {
  it('names every check id in the validator, X1 to X4 and the warn list included', () => {
    expect(RULE_IDS).toEqual(expect.arrayContaining(['C1', 'X1', 'X2', 'X3', 'X4', 'OUR', 'SOFT', 'SPACED_DASH', 'LONG_SENTENCE', 'C2.L7']));
    expect(RULE_IDS.filter((id) => !CHECK_NAMES[id])).toEqual([]);
    expect(RULE_IDS.filter((id) => !WHY_OF[id])).toEqual([]);
  });
});

describe('a failed check on /review/:id', () => {
  it('C7 shows the sentence, the words marked, the reason and the next step', () => {
    const full = page(view({ landing_page: { sections: [{ type: 'hero' }, { type: 'story', text: 'A quiet evening. Wear one piece and let it lead. Then rest.' }] } }, [C7]));
    const html = full.slice(0, full.indexOf('Raw model output'));
    expect(html).toContain('Wear <mark>one piece</mark> and let it lead.');
    expect(html).not.toContain('A quiet evening.');
    expect(html).toContain('The copy states a quantity the product page does not give');
    expect(html).toContain('What to do');
    expect(html).not.toContain('C7:');
  });
  it('C4 resolves the rule id to the words in the draft and never shows the id', () => {
    const html = page(view({ email: { body: 'A long lunch. Do hurry, the table fills. Good.' } }, [C4]));
    expect(html).toContain('Do <mark>hurry</mark>, the table fills.');
    expect(html).toContain('pressure');
    expect(html).not.toContain('c4.032');
  });
  it('says Stopped in words, not CHECKS_FAILED', () => {
    expect(stoppedLine([C7])).toBe('Stopped: 1 check failed on the landing page');
    expect(stoppedLine([C7, { ...C7, field: 'x' }, C4])).toBe('Stopped: 2 checks failed on the landing page and the email');
    expect(page(view({}, [C7]))).not.toContain('CHECKS_FAILED');
  });
  it('a past-item span is shown as words, not as a pattern', () => {
    const c: CheckResult = { id: 'C8n', part: 'email', severity: 'hard', pass: false, code: 'PAST_ITEM', field: 'body', detail: '\\bsilk\\s+evening\\b' };
    expect(explain(c, { email: { body: 'The silk evening stole again.' } } as never, new Map()).html).toContain('<mark>silk evening</mark>');
    const n: CheckResult = { ...c, detail: 'shirt + last summer' };
    expect(explain(n, { email: { body: 'The shirt from last summer.' } } as never, new Map()).html).toBe('<p>The <mark>shirt</mark> from <mark>last summer</mark>.</p>');
  });
  it('puts product names back and marks a token run', () => {
    const c: CheckResult = { id: 'C8d-x', part: 'email', severity: 'hard', pass: false, code: 'CAPITAL_RUN', field: 'body', detail: 'Titlespan Grand' };
    expect(explain(c, { email: { body: 'See {p1} Grand today.' } } as never, new Map([['p1', 'Moon Scarf']])).html).toBe('<p>See <mark>Moon Scarf Grand</mark> today.</p>');
  });
  it('escapes model text, marked or not', () => {
    const c = { ...C4, detail: 'c4.032' };
    const e = explain(c, { email: { body: '<img src=x> hurry <b>now</b>.' } } as never, new Map());
    expect(e.html).toBe('<p>&lt;img src=x&gt; <mark>hurry</mark> &lt;b&gt;now&lt;/b&gt;.</p>');
    expect(highlight('a <b> c', ['<b>'])).toBe('a <mark>&lt;b&gt;</mark> c');
  });
  it('a word it cannot find says so and still hides the id', () => {
    const e = explain(C4, { email: { body: 'Nothing here.' } } as never, new Map());
    expect(e.html).toBeNull();
    expect(JSON.stringify(e)).not.toContain('c4.032');
  });
  it('an image failure shows the address, with no sentence to find', () => {
    const c: CheckResult = { id: 'X2', part: 'email', severity: 'hard', pass: false, code: 'IMG_HOST', detail: 'https://evil.test/a.jpg' };
    const e = explain(c, {} as never, new Map());
    expect(e.html).toContain('https://evil.test/a.jpg');
    expect(e.name).toBe('Image not from nicobar.com');
  });
});

describe('not run says why', () => {
  it('a format failure stops everything after it', () => {
    const c1: CheckResult = { id: 'C1', part: 'email', severity: 'hard', pass: false, code: 'SCHEMA', detail: '/subject too short' };
    expect(page(view({}, [c1]))).toContain('Not run: the draft failed its format check first');
  });
  it('a page that could not be built leaves images unchecked', () => {
    const ok: CheckResult = { id: 'C8', part: 'email', severity: 'hard', pass: true };
    expect(page(view({}, [ok]))).toContain('Not run: the page could not be built');
  });
  it('Jev: a failed draft is never sent; otherwise the stored reason', () => {
    expect(page(view({}, [C7]), [] as never)).toContain('Not run: a draft that fails a check is not sent to Jev');
    const clean = view({}, [], { status: 'in_review' });
    expect(page(clean, [] as never, { jev: { status: 'unavailable', reason: 'no_key' } })).toContain('Not run: no Jev key was set');
  });
});
