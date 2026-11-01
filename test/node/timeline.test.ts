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

describe('every step opens to its evidence', () => {
  const CATALOG = '<a class="nb-card" data-slot="p1" href="https://www.nicobar.com/products/a"><img data-slot="p1" src="https://cdn.shopify.com/s/a.jpg?width=800" alt="Brass Bowl &lt;x&gt;" width="800" height="1000" loading="lazy"></a><a class="nb-card" data-more="9" href="https://www.nicobar.com/products/m"><img data-more="9" src="https://cdn.shopify.com/s/m.jpg"></a>';
  const ENV = JSON.stringify({ model: 'claude-sonnet-5-5', setting: 'S1', prompt_version: 'v7', validator_version: 'check-3', carried_from: null, carried_part: null });
  const plan = { display_name: 'Asha', occasion: 'A wedding', occasion_key: 'wedding', shape: 'wedding', new_user: false, format: 'both', signals: [], picks: [{ slot: 'p1', product_id: '111', reason_code: 'OCCASION_MATCH', group: 'home' }, { slot: 'p2', product_id: '222', reason_code: 'SAME_MATERIAL', group: 'home' }],
    more: [{ kind: 'occasion', heading: 'More for the day', product_ids: ['9', '8'] }], outcome: { kind: 'ready' } } as never;
  const unit = (status: string, code: string | null = null) => ({ customer_id: 'c04', status, code, error_detail: null });
  const raw = '{"email":{"subject":"</pre><script>alert(1)</script>","body":"For {p1}."}}';
  const gen = (attempt: number, over = {}) => ({ customer_id: 'c04', attempt, result_type: 'answered', stop_reason: 'end_turn', ms: 12300,
    usage_json: JSON.stringify({ input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 700, output_tokens_details: { thinking_tokens: 40 } }),
    message_json: JSON.stringify({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: raw }] }), ...over });
  const okChecks = [{ id: 'C4', part: 'email', severity: 'hard', pass: true }, { id: 'C3.L', part: 'landing_page', severity: 'hard', pass: true }, { id: 'X2', part: 'email', severity: 'hard', pass: true },
    { id: 'SOFT', part: 'email', severity: 'warn', pass: false, code: 'SOFT', field: 'body', detail: '' }];
  const good = (version: number, over = {}) => draft(version, 'approved', okChecks, { hard_failures: 0, catalog: CATALOG, envelope_json: ENV, validator_version: 'check-3', model: 'claude-sonnet-5-5', content_sha256: 'abc123hash',
    email: '<img src="x"><a href="y">a</a><a href="z">b</a>', landing: '<img src="x"><img src="y"><a href="z">c</a>', model_json: JSON.stringify({ email: { subject: 'New words', body: 'For {p1}.' }, landing_page: { sections: [{ type: 'story', text: 'Kept page' }] } }), ...over });
  const ev = (v: number, to: string, email: string | null, at: string) => ({ ...event(v, to, at), actor_email: email, content_sha256: 'abc123hash' });
  const jevRun = { ...run, setting: 'rung-a', format: 'both', cap_run_usd: 1, jev_reserve_usd: 0.1, pool_usd: 0.05,
    jev: { flag_gate: 0.5, score_flag_confidence: 0.6, j3: { pressure: { type: 'noul', bad: true }, quiet: { type: 'score', bad: 'lowest' }, specific: { type: 'noul', bad: false } } } } as never;
  const answers = JSON.stringify({ pressure: { noul: 0.7 }, quiet: { probabilities: { 0: 0.2, 1: 0.8 }, confidence: 0.9 }, specific: { noul: 0.9 } });

  const passed: CustomerData = { unit: unit('drafted'), plan, plan_at: 't', drafts: [good(1)], costs: [cost(1, { setting: 'S1', request_sha256: 'reqhash1', commit_usd: 0.1 })], gens: [gen(1)], budgetLeft: 0.75,
    jev: [{ customer_id: 'c04', attempt: 1, status: 'answered', reason: null, charged_usd: 0.0005, at: 't', answers_json: answers, input_tokens: 321, ms: 800 }], flags: ['pressure'],
    events: [ev(1, 'in_review', null, '2026-11-01T06:21:48.150Z'), ev(1, 'approved', 'meera@nicobar.test', '2026-11-01T07:00:00.000Z'), ev(1, 'released', 'meera@nicobar.test', '2026-11-01T07:05:00.000Z')] };
  const retried: CustomerData = { ...passed, drafts: [draft(1, 'failed', [C7], { catalog: CATALOG, envelope_json: ENV, model_json: JSON.stringify({ email: { subject: 'Kept mail' }, landing_page: { sections: [{ type: 'story', text: 'Old failed words' }] } }) }),
    good(2, { envelope_json: JSON.stringify({ ...JSON.parse(ENV), carried_part: 'email' }), model_json: JSON.stringify({ email: { subject: 'Kept mail' }, landing_page: { sections: [{ type: 'story', text: 'New passing words' }] } }) })],
    costs: [cost(1), cost(2, { request_sha256: 'reqhash2' })], gens: [gen(1), gen(2)], jev: [{ customer_id: 'c04', attempt: 2, status: 'answered', reason: null, charged_usd: 0.0005, at: 't', answers_json: answers }], flags: [],
    events: [ev(2, 'in_review', null, '2026-11-01T06:21:48.150Z')] };
  const stopped: CustomerData = { ...failedC, gens: [gen(1), gen(2)] };

  const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('a passed customer shows every step, closed', () => {
    const h = customerTimeline(passed, jevRun), t = text(h);
    for (const s of ['Brass Bowl &lt;x&gt;', 'Fits the occasion', 'wedding', 'More for the day', '2 products', 'New customer No', 'Dropped not recorded', 'Input tokens 5,000', '$0.0500', 'Left in the budget $0.7500',
      'Spare pool in the run now $0.0500', 'claude-sonnet-5-5', 'S1', 'v7', 'reqhash1', 'Thinking tokens 40', 'Finished normally', '12.3 s', 'check-3', 'Soft sales word', 'To read', 'Email', 'Landing page', 'Email images 1', 'Email links 2', 'Landing page images 2', 'abc123hash',
      'Pressures the reader', 'Flagged', 'Not quiet in tone', 'Not flagged', 'meera@nicobar.test', '07:00:00']) expect(t).toContain(s);
    expect(t).toContain('Under the estimate by');
    expect(h).toContain('src="https://cdn.shopify.com/s/a.jpg?width=80"');
    expect(h).not.toMatch(/<details[^>]*\sopen/);
    expect(h.match(/<details/g)!.length).toBeGreaterThanOrEqual(9);
  });
  it('the gate is read by the one reader: the inverted question is not flagged', () => {
    const t = text(customerTimeline(passed, jevRun));
    expect(t).toContain('Not specific about the product 0.10');
    expect(t).toContain('Pressures the reader 0.70 Flag at 0.50 Flagged');
  });
  it('a retried customer shows which part, why, what was carried, and both texts', () => {
    const t = text(customerTimeline(retried, jevRun));
    for (const s of ['Rewrote the landing page', 'Because of Claim not on the product page', 'Carried the email', 'Old failed words', 'New passing words', 'reqhash2']) expect(t).toContain(s);
    expect(customerTimeline(retried, jevRun)).toContain('class="ev-pair"');
  });
  it('a failed customer shows its evidence and says what is not stored', () => {
    const t = text(customerTimeline(stopped, run));
    for (const s of ['Prompt version not recorded', 'Claim not on the product page', 'Validator version not recorded', 'Thinking tokens 40']) expect(t).toContain(s);
    expect(t).not.toContain('Pressures the reader');
  });
  it('an old run with nothing stored reads not recorded', () => {
    const t = text(customerTimeline({ ...passed, gens: undefined, jev: passed.jev.map((j) => ({ ...j, ms: null })) }, jevRun));
    expect(t).toContain('Thinking tokens not recorded');
    expect(t).toContain('Time taken not recorded');
    expect(t).toContain('Raw answer not recorded');
  });
  it('the raw answer is escaped, closed, and carries no thinking', () => {
    const h = customerTimeline(passed, jevRun);
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toMatch(/<details class="ev"><summary>The model&#39;s raw answer<\/summary><pre>/);
    expect(h).not.toContain('hidden');
  });
  it('the run page has stages with who was in them, totals, cache rate, slowest and costliest', () => {
    const slow = { ...passed, unit: { ...passed.unit, customer_id: 'c09' }, plan: { ...(plan as object), display_name: 'Kabir' } as never, gens: [gen(1, { ms: 50000 })], costs: [cost(1, { charged_usd: 0.09 })] };
    const h = runTimeline(jevRun, [passed, slow]), t = text(h);
    expect(h.match(/<style>/g)!.length).toBe(1);
    for (const s of ['Each step in detail', 'Asha', 'Input tokens 1,800', 'Cached tokens 8,000', 'Cache hit rate 80%', 'Estimated $0.1000', 'Slowest customers Kabir · A wedding 50.8 s', 'Costliest customers Kabir · A wedding $0.09']) expect(t).toContain(s);
  });
});
