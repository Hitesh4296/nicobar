// /review/evals: a row answers what it was, why it is wrong, and who caught it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import cases from '../../reports/cases.json' with { type: 'json' };
import { renderEvals, type RealDraft } from '../../src/ui/demo/index.ts';

const c = (id: string) => cases.cases.find((x) => x.id === id)!;
const h3 = (over = {}) => ({ id: 'H-03', source: 'heldout', customer: 'c03', occasion: 'Dinner', text: 'x', jev: { status: 'answered', flags: ['names_unselected_product'], scores: {} },
  sonnet: { status: 'answered', answers: { names_unselected_product: { flag: true, quote: 'A matching pair of Noorani drop earrings', why: 'Not one of the <b>picks</b>.', quote_invalid: false } } }, cost: { jev_usd: 0, sonnet_usd: 0 }, ...over });
const base = { eval: {}, readiness: null, cases, judges: { cases: [] as unknown[] } };

describe('cases.json', () => {
  it('holds all 80, every planted phrase is in its text, every row says why', () => {
    expect(cases.cases).toHaveLength(80);
    expect(new Set(cases.cases.map((x) => x.kind))).toEqual(new Set(['Made-up product', 'Discount or pressure', 'Too long', 'Mentions a past purchase', 'Image not from nicobar.com']));
    for (const x of cases.cases) {
      expect(x.why.length, x.id).toBeGreaterThan(20);
      for (const p of x.planted) expect(x.text, x.id).toContain(p);
    }
  });
  it('the 7 misses of the second set carry their text', () => {
    for (const id of ['h2-08', 'h2-09', 'h2-11', 'h2-13', 'h2-27', 'h2-31']) expect(c(id).code.blocked, id).toBe(false);
    expect(c('h2-09').text).toContain('still in stock');
  });
});

describe('the page', () => {
  it('H-03 reads in plain words: what, why, who caught it', () => {
    const html = renderEvals({ ...base, judges: { cases: [h3()] } });
    expect(html).toContain('<mark>A matching pair of Noorani drop earrings</mark>');
    expect(html).toContain(c('H-03').why);
    expect(html).toContain('H-03 · Made-up product');
    expect(html).toContain('Flagged for reviewer');
  });
  it('escapes model strings', () => {
    const html = renderEvals({ ...base, judges: { cases: [h3()] } });
    expect(html).toContain('Not one of the &lt;b&gt;picks&lt;/b&gt;.');
    expect(html).not.toContain('<b>picks');
  });
  it('no judges file: not judged yet, and the verdict does not claim a flag', () => {
    const html = renderEvals(base);
    expect(html).toContain('not judged yet');
    expect(html).not.toContain('<b>Flagged for reviewer</b>');
    expect(html.indexOf('Would get through')).toBeLessThan(html.indexOf('Stopped by code'));
  });
  it('Sonnet alone flags nothing for a reviewer: it is not in the live batch', () => {
    const html = renderEvals({ ...base, judges: { cases: [h3({ jev: { status: 'answered', flags: [], scores: {} } })] } });
    const row = html.slice(html.indexOf('H-03 · Made-up product'));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('Would get through');
  });
  it('a quote not in the text does not count as caught', () => {
    const judged = h3();
    (judged.sonnet.answers.names_unselected_product as any).quote_invalid = true;
    const html = renderEvals({ ...base, judges: { cases: [judged] } });
    expect(html).toContain('Quote not found in the draft');
    const row = html.slice(html.indexOf('H-03 · Made-up product'));
    expect(row.slice(0, row.indexOf('</tr>')).match(/class="pass">Caught/g)).toHaveLength(1);   // Jev's; Sonnet's is not counted
  });
  it('raw JSON stays closed at the end; four plain numbers at the top', () => {
    const html = renderEvals(base);
    expect(html.lastIndexOf('<details>')).toBeGreaterThan(html.indexOf('Real drafts'));
    for (const s of ['Planted problems', 'Caught by code', 'Caught by Jev', 'Caught by Sonnet']) expect(html).toContain(s);
  });
  it('real drafts: a retried failure and a flag each say what to do, no bare code', () => {
    const fail = { id: 'C4', part: 'email', severity: 'hard', pass: false, code: 'urgency-scarcity', field: 'body', detail: 'c4.032' };
    const real: RealDraft[] = [
      { id: 'r:c01:v1', customer_id: 'c01', version: 1, model_json: JSON.stringify({ email: { body: 'Do hurry now.' } }), catalog: null, checks: [fail] as never, flags: [] },
      { id: 'r:c01:v2', customer_id: 'c01', version: 2, model_json: JSON.stringify({ email: { body: 'Take your time.' } }), catalog: null, checks: [], flags: ['claims_customer'] }];
    const html = renderEvals(base, real, 'run-1');
    expect(html).toContain('Do <mark>hurry</mark> now.');
    expect(html).toContain('Retried and fixed');
    expect(html).toContain('Reviewer to read');
    expect(html).not.toContain('c4.032');
    expect(html).not.toMatch(/>C4</);
  });
  it('the source file has no check id without a name: the page reads names from the one map', () => {
    expect(readFileSync('src/ui/review.ts', 'utf8')).not.toContain('const NAMED');
  });
});
