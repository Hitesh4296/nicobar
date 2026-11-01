// The job as a timeline: a strip for the run, the same stages per customer, nothing invented where nothing is stored.
import { describe, expect, it } from 'vitest';
import { customerTimeline, runTimeline, stagesOf, STAGES, type CustomerData } from '../../src/ui/timeline.ts';
import { renderEvals } from '../../src/ui/demo/index.ts';
import cases from '../../reports/cases.json' with { type: 'json' };

const C7 = { id: 'C7', part: 'landing_page', severity: 'hard', pass: false, code: 'UNGROUNDED_COUNT', field: 'sections[0].text', detail: 'one piece' };
const draft = (version: number, status: string, checks: object[], over = {}) => ({ id: `r:c04:v${version}`, customer_id: 'c04', version, status, hard_failures: checks.filter((c: any) => !c.pass).length,
  model_json: JSON.stringify({ landing_page: { sections: [{ type: 'story', text: 'Wear one piece <b>tonight</b>.' }] } }), catalog: null, checks_json: JSON.stringify(checks), envelope_json: '{}', ...over });
const cost = (attempt: number, over = {}) => ({ customer_id: 'c04', attempt, action: attempt === 1 ? 'admit' : 'retry', call_state: 'answered', input_tokens: 5000, est_usd: 0.05, charged_usd: 0.04, reason: null, at: '2026-11-01T06:21:48.150Z', ...over });
const event = (v: number, to: string, at: string) => ({ draft_id: `r:c04:v${v}`, from_status: 'draft', to_status: to, actor_email: null, at, note: null });
const failedC: CustomerData = { unit: { customer_id: 'c04', status: 'failed', code: 'CHECKS_FAILED', error_detail: null }, plan: { display_name: '<i>Asha</i>', occasion: "Father's sixtieth", picks: [{}, {}], outcome: { kind: 'ready' } } as never, plan_at: '2026-11-01T06:21:41.773Z',
  drafts: [draft(1, 'failed', [C7]), draft(2, 'failed', [C7])], costs: [cost(1), cost(2)], jev: [], events: [event(1, 'failed', '2026-11-01T06:22:41.597Z'), event(2, 'failed', '2026-11-01T06:23:00.959Z')], flags: [] };
const run = { id: 'r', status: 'done', jev_disabled_reason: null };

describe('a failed customer reads end to end with no code', () => {
  const html = customerTimeline(failedC, run);
  it('says what, why, the sentence and the retry', () => {
    expect(html).toContain('Wear <mark>one piece</mark> &lt;b&gt;tonight&lt;/b&gt;.');
    expect(html).toContain('The copy states a quantity the product page does not give.');
    expect(html).toContain('still failed');
    expect(html).toContain('Stopped: 1 check failed on the landing page');
  });
  it('shows no check id or status code', () => {
    const text = html.replace(/<[^>]+>/g, ' ');
    for (const c of ['C7', 'CHECKS_FAILED', 'UNGROUNDED', 'admit']) expect(text).not.toContain(c);
  });
  it('a time that is not stored says so', () => expect(html).toContain('not recorded'));
  it('leads with the outcome, and capitalises the name', () => {
    const plain: CustomerData = { ...failedC, plan: { ...failedC.plan, display_name: 'kabir singh' } as never, drafts: [draft(1, 'failed', [C7]), draft(2, 'failed', [{ id: 'C3.L', part: 'landing_page', severity: 'hard', pass: false, code: 'OVER_WORDS', field: 'sections', detail: '130' }])] };
    const h = customerTimeline(plain, run);
    expect(h).toContain('Stopped after retry: the page is 10 words too long');
    expect(h).toContain('Kabir Singh');
    expect(runTimeline(run, [plain])).toContain('Stopped: Landing page 130 words, limit 120, after retry');
  });
  it('stops at the stage where it stopped', () => {
    const s = stagesOf(failedC, run);
    expect(s.map((x) => x.state)).toEqual(['passed', 'passed', 'passed', 'passed', 'failed', 'failed', 'not reached', 'not reached', 'not reached', 'not reached', 'not reached']);
    expect(s[3].at).toBeNull();
    expect(s[3].usd).toBeCloseTo(0.04);
    expect(s[5].usd).toBeCloseTo(0.04);
  });
});

describe('other shapes', () => {
  it('a customer with no history stops at Plan, in words', () => {
    const c: CustomerData = { ...failedC, unit: { customer_id: 'c20', status: 'failed', code: 'COLD_START_NO_HISTORY', error_detail: null }, plan: { display_name: null, occasion: null, picks: [], outcome: { kind: 'failed', code: 'COLD_START_NO_HISTORY' } } as never, drafts: [], costs: [], events: [] };
    expect(stagesOf(c, run).map((s) => s.state).slice(0, 2)).toEqual(['failed', 'not reached']);
    expect(customerTimeline(c, run)).toContain('no purchase history');
  });
  it('over the cap is skipped at Cap check', () => {
    const c: CustomerData = { ...failedC, unit: { customer_id: 'c04', status: 'skipped', code: 'OVER_CAP', error_detail: null }, drafts: [], events: [], costs: [cost(1, { action: 'skip', call_state: 'blocked', charged_usd: null, reason: 'OVER_CAP' })] };
    expect(stagesOf(c, run)[2].state).toBe('skipped');
    expect(customerTimeline(c, run)).toContain('over the spending cap');
  });
  it('a retry that passed is retried, and Jev runs on it', () => {
    const ok = { id: 'X1', part: 'email', severity: 'hard', pass: true };
    const c: CustomerData = { ...failedC, unit: { customer_id: 'c04', status: 'drafted', code: null, error_detail: null }, drafts: [draft(1, 'failed', [C7]), draft(2, 'in_review', [ok], { envelope_json: '{"carried_part":"email"}' })],
      jev: [{ customer_id: 'c04', attempt: 2, status: 'answered', reason: null, charged_usd: 0.0001, at: 't' }], flags: ['claims_customer'] };
    const s = stagesOf(c, run);
    expect(s[5].state).toBe('retried');
    expect(s[6].state).toBe('passed');
    expect(s[7].what).toContain('Claims something about the customer');
    expect(s[8].state).toBe('waiting');
    expect(customerTimeline(c, run)).toContain('The email was kept');
  });
  it('a stub run renders and says so; names escape', () => {
    const html = runTimeline({ id: 'stub-rehearsal-1', status: 'done', jev_disabled_reason: 'no_key' }, [failedC]);
    expect(html).toContain('stub');
    expect(html).toContain('&lt;i&gt;Asha&lt;/i&gt;');
    expect(html).not.toContain('<i>Asha');
    for (const s of STAGES) expect(html).toContain(s.name.replace('&', '&amp;'));
    expect(html).toContain('<details');
  });
  it('run strip adds up: in, passed, failed, cost', () => {
    const html = runTimeline(run, [failedC]);
    expect(html).toContain('$0.04');
    expect(html).toContain('1 customer stopped alone and the other 0 finished');
  });
});

describe('the eval funnel', () => {
  it('runs from 40 + 40 to what would get through', () => {
    const html = renderEvals({ eval: {}, readiness: null, cases, judges: { cases: [] } });
    for (const s of ['Planted', 'Code checks', 'Reviewer', '40 + 40', 'Would get through', '67 stopped', '13 through']) expect(html).toContain(s);
  });
});
