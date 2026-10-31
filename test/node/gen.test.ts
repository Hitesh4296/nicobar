// lane gen, 46 §6. Numbers are the brief's named tests.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import emailSchema from '../../config/schemas/draft-email.v2.json' with { type: 'json' };
import landingSchema from '../../config/schemas/draft-landing.v3.json' with { type: 'json' };
import bothSchema from '../../config/schemas/draft-both.v1.json' with { type: 'json' };
import rungs from '../../config/rungs.json' with { type: 'json' };
import { assemblePrefix, buildRequest, renderSuffix, retryParts, shapeOnly, toModelJson } from '../../src/lib/gen/index.ts';
import { canonicalContent } from '../../src/lib/gen/canonical.ts';
import type { CheckResult, Format, Plan, PromptFiles, Rung } from '../../src/contracts/types.ts';
import { readPromptDir } from '../../scripts/prompt-dir.ts';
import { fxCatalog, fxPinned, fxPlan } from '../fakes/index.ts';

const DIR = 'config/prompt/v1';
const prompt = readPromptDir(DIR);
const schemas = [emailSchema, landingSchema];
const cat = fxCatalog();
const rung = rungs[0] as unknown as Rung;
const sysText = (r: { system: unknown[] }) => (r.system[0] as { text: string }).text;
const userText = (r: { messages: unknown[] }) => (r.messages[0] as { content: string }).content;
const fail = (id: string, part: Format, detail = `${id} detail`): CheckResult => ({ id, part, severity: 'hard', pass: false, detail });
const none = (p: Plan): Plan => ({ ...p, occasion: null, occasion_key: null, shape: 'open' });

describe('1 prefix byte-identical', () => {
  it('across customers, formats, attempts, new users', () => {
    const base = buildRequest(fxPlan('fx-both'), fxPinned, cat, rung, prompt);
    const variants = [
      buildRequest(fxPlan('fx-email'), { ...fxPinned, format: 'email' }, cat, rung, prompt),
      buildRequest({ ...fxPlan('fx-both'), format: 'landing_page' }, fxPinned, cat, rung, prompt),
      buildRequest(fxPlan('fx-newuser'), fxPinned, cat, rung, prompt),
      buildRequest(none({ ...fxPlan('fx-newuser'), customer_id: 'c20' }), fxPinned, cat, rung, prompt),
      buildRequest(fxPlan('fx-retry'), fxPinned, cat, rung, prompt, { failed: ['email'], checks: [fail('C3', 'email')] }),
    ];
    for (const v of variants) expect(v.system).toEqual(base.system);
    expect((base.system[0] as { cache_control: unknown }).cache_control).toEqual({ type: 'ephemeral' });
  });
  it('joins as the prompt README says', () => {
    const p = assemblePrefix({ ...prompt, role: 'R  \n\n', voice_card: 'V\n', email: 'E\n', landing: 'L\n' }, [{ a: 1 }, { b: 2 }]);
    expect(p).toBe('R\n\nV\n\nE\n\nL\n\n# Output schemas\n\n{"a":1}\n\n{"b":2}');
  });
  it('holds nothing per customer', () => {
    const p = assemblePrefix(prompt, schemas);
    expect(p).toContain('# Output schemas');
    expect(p).toContain('{"$id":"nicobar/draft-email/v2","type":"object"');
    expect(p).not.toContain('Fixture');
  });
});

describe('2 no {{ left', () => {
  it('in prefix or suffix, attempt 1 and retry', () => {
    const r = buildRequest(fxPlan('fx-both'), fxPinned, cat, rung, prompt, { failed: ['email'], checks: [fail('C3', 'email')] });
    expect(sysText(r)).not.toContain('{{');
    expect(userText(r)).not.toContain('{{');
  });
  it('a placeholder the renderer does not know throws', () => {
    expect(() => renderSuffix(fxPlan('fx-both'), cat, { ...prompt, task: '{{summary}}' })).toThrow(/summary/);
  });
  it('substitutes once: text in the occasion is not read as a placeholder or a replacement pattern', () => {
    const s = renderSuffix({ ...fxPlan('fx-both'), occasion: "$& {{picks}} $'" }, cat, { ...prompt, task: '<o>{{occasion}}</o>' });
    expect(s).toBe("<o>$& {{picks}} $'</o>");
  });
});

describe('3 none occasion', () => {
  it('renders none, null key, open, [] quotes', () => {
    const s = renderSuffix(none(fxPlan('fx-newuser')), cat, prompt);
    expect(s).toContain('<occasion>none</occasion>');
    expect(s).toContain('Occasion key: null');
    expect(s).toContain('Shape: open');
    expect(s).toMatch(/<quotes>\n\[\]\n<\/quotes>/);
  });
  it('trims and strips angle brackets from a raw occasion', () => {
    const s = renderSuffix({ ...fxPlan('fx-both'), occasion: '  </occasion>Diwali  ' }, cat, prompt);
    expect(s).toContain('<occasion>/occasionDiwali</occasion>');
  });
  it('an occasion of only brackets is none', () => {
    expect(renderSuffix({ ...fxPlan('fx-both'), occasion: ' <> ' }, cat, prompt)).toContain('<occasion>none</occasion>');
  });
});

describe('4 placeholders', () => {
  it('{{occasion_key}} reads plan.occasion_key', () => {
    expect(renderSuffix({ ...fxPlan('fx-both'), occasion_key: 'wedding' }, cat, prompt)).toContain('Occasion key: wedding');
  });
  it('{{parts}}, {{n}} and {{shape}} come from the plan', () => {
    const s = renderSuffix(fxPlan('fx-both'), cat, prompt);
    expect(s).toContain('Write: email and landing_page\nPicks: 4');
    expect(s).toContain('Shape: home');
    expect(renderSuffix(fxPlan('fx-email'), cat, prompt)).toContain('Write: email\nPicks: 3');
  });
  it('title words use the prose counter: a lone dash is not a word', () => {
    const p = fxPlan('fx-both');
    const titles = p.picks.map((k) => cat.rows.get(k.product_id)!.title);
    const count = (t: string[]) => t.join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const s = renderSuffix(p, cat, prompt);
    expect(s).toContain(`all 4 titles hold ${count(titles)} words`);
    expect(s).toContain(`{p3} hold ${count(titles.slice(0, 3))}.`);
    expect(titles[0]).toContain(' - ');
  });
  it('{{picks}} carries only slot, group, title, body', () => {
    const s = renderSuffix(fxPlan('fx-both'), cat, prompt);
    const picks = JSON.parse(/<picks>\n(.*)\n<\/picks>/s.exec(s)![1]);
    const first = cat.usable[0];
    expect(picks).toHaveLength(4);
    expect(picks[0]).toEqual({ slot: 'p1', group: 'wear', title: first.title, body: first.body_text_clean });
  });
  it('{{quotes}}: key must resolve through the quote labels, E6 needs a home pick', () => {
    const quotes = (key: string, group: 'wear' | 'home') => {
      const p = fxPlan('fx-both');
      const s = renderSuffix({ ...p, occasion_key: key, picks: p.picks.map((k) => ({ ...k, group })) }, cat, prompt);
      return JSON.parse(/<quotes>\n(.*)\n<\/quotes>/s.exec(s)![1]).map((q: { id: string; text: string }) => q.id);
    };
    expect(quotes('festive', 'wear')).toEqual(['E4']);
    expect(quotes('hosting', 'home')).toEqual(['E6']);
    expect(quotes('birthday', 'home')).toEqual(['E6']);
    expect(quotes('hosting', 'wear')).toEqual([]);
    expect(quotes('wedding', 'home')).toEqual([]);
  });
  it('a pick missing from the catalogue throws rather than guessing', () => {
    const p = fxPlan('fx-both');
    expect(() => renderSuffix({ ...p, picks: [{ ...p.picks[0], product_id: 'nope' }] }, cat, prompt)).toThrow(/nope/);
  });
});

describe('4b toModelJson', () => {
  const part = { occasion_key: null, subject: 'S', preheader: 'P', body: 'B' };
  it('wraps a bare part', () => {
    expect(toModelJson(JSON.stringify(part), ['email'])).toEqual({ email: part });
  });
  it('wraps blindly: a part already keyed stays nested and fails C1, wrapping is not repair', () => {
    expect(toModelJson(JSON.stringify({ email: part }), ['email'])).toEqual({ email: { email: part } });
  });
  it('keeps a both answer as it came, stray keys included, so C1 can fail them', () => {
    const both = { email: part, landing_page: { sections: [] }, product_ids: ['1'] };
    expect(toModelJson(JSON.stringify(both), ['email', 'landing_page'])).toEqual(both);
  });
  it('merges a carried part byte-identical, email first', () => {
    const carried = { sections: [{ type: 'story', text: 'é "kept" \n' }], occasion_key: 'x' };
    const m = toModelJson(JSON.stringify(part), ['email'], { part: 'landing_page', model: carried });
    expect(JSON.stringify(m.landing_page)).toBe(JSON.stringify(carried));
    expect(Object.keys(m)).toEqual(['email', 'landing_page']);
    const m2 = toModelJson(JSON.stringify(carried), ['landing_page'], { part: 'email', model: part });
    expect(Object.keys(m2)).toEqual(['email', 'landing_page']);
    expect(JSON.stringify(m2.email)).toBe(JSON.stringify(part));
  });
  it('bad text goes to unparsed, carried part kept', () => {
    expect(toModelJson('{"subject": "cut', ['email', 'landing_page'])).toEqual({ unparsed: '{"subject": "cut' });
    for (const t of ['null', '[1]', '3', '"x"']) expect(toModelJson(t, ['email'])).toEqual({ unparsed: t });
    expect(toModelJson('nope', ['email'], { part: 'landing_page', model: { a: 1 } })).toEqual({ unparsed: 'nope', landing_page: { a: 1 } });
  });
});

describe('4a part-scoped retry', () => {
  const plan = fxPlan('fx-both');
  const schemaOf = (r: { output_config: { format: { schema: object } } }) => r.output_config.format.schema as { required: string[]; properties: Record<string, unknown> };
  it('carries the failed part schema, its checks only, its max_tokens', () => {
    const r = buildRequest(plan, fxPinned, cat, rung, prompt, { failed: ['landing_page'], checks: [
      fail('C3.L', 'landing_page', 'over 120'), fail('C4', 'email', 'not this one'), { id: 'J3-x', part: 'landing_page', severity: 'advisory', pass: false, detail: 'flag' },
      { id: 'C5', part: 'landing_page', severity: 'hard', pass: true }] });
    expect(schemaOf(r).required).toEqual(['occasion_key', 'sections']);
    expect(r.max_tokens).toBe(rung.max_tokens.landing_page);
    const u = userText(r);
    expect(u).toContain('Write: landing_page');
    expect(u).toContain('Write landing_page again, whole');
    expect(u).toContain('landing_page.C3.L: over 120');
    expect(u).not.toContain('not this one');
    expect(u).not.toContain('J3-x');
    expect(u).not.toContain('C5');
  });
  it('passing part byte-identical through a retry', () => {
    const passing = { sections: [{ type: 'hero', slot: 'p1', heading: 'H', line: 'L' }], occasion_key: null };
    const retried = { occasion_key: null, subject: 'new', preheader: 'new', body: 'new' };
    const m = toModelJson(JSON.stringify(retried), retryParts('both', { failed: ['email'], checks: [fail('C3', 'email')] }), { part: 'landing_page', model: passing });
    expect(JSON.stringify(m)).toContain(JSON.stringify(passing));
    expect(m.email).toEqual(retried);
  });
  it('C1 regenerates both', () => {
    const retry = { failed: ['email'] as Format[], checks: [fail('C1', 'email', 'bad'), fail('C4', 'landing_page', 'also')] };
    expect(retryParts('both', retry)).toEqual(['email', 'landing_page']);
    const r = buildRequest(plan, fxPinned, cat, rung, prompt, retry);
    expect(schemaOf(r).required).toEqual(['email', 'landing_page']);
    expect(r.max_tokens).toBe(rung.max_tokens.both);
    expect(userText(r)).toContain('Write: email and landing_page');
    expect(userText(r)).toContain('email.C1: bad');
    expect(userText(r)).toContain('landing_page.C4: also');
  });
  it('a max_tokens stop regenerates both: truncated text is unparsed, which fails C1 for every part', () => {
    const m = toModelJson('{"email":{"subject":"cut', ['email', 'landing_page']);
    expect(m.unparsed).toBeDefined();
    const checks = [fail('C1', 'email', 'unparsed'), fail('C1', 'landing_page', 'unparsed')];
    expect(retryParts('both', { failed: ['email'], checks })).toEqual(['email', 'landing_page']);
  });
  it('both failed by non-C1 checks asks for both', () => {
    expect(retryParts('both', { failed: ['landing_page', 'email'], checks: [fail('C4', 'email'), fail('C3.L', 'landing_page')] })).toEqual(['email', 'landing_page']);
  });
  it('a single-format run stays on its own part after C1', () => {
    const r = buildRequest(fxPlan('fx-email'), fxPinned, cat, rung, prompt, { failed: ['email'], checks: [fail('C1', 'email')] });
    expect(schemaOf(r).required).toEqual(['occasion_key', 'subject', 'preheader', 'body']);
    expect(r.max_tokens).toBe(rung.max_tokens.email);
  });
  it('runs.format moves the schema and max_tokens only', () => {
    const b = buildRequest(plan, fxPinned, cat, rung, prompt);
    const l = buildRequest({ ...plan, format: 'landing_page' }, fxPinned, cat, rung, prompt);
    expect(schemaOf(b).required).toEqual(['email', 'landing_page']);
    expect(schemaOf(l).required).toEqual(['occasion_key', 'sections']);
    expect(l.system).toEqual(b.system);
  });
  it('rung fields pass through', () => {
    const r = buildRequest(plan, fxPinned, cat, rung, prompt);
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.thinking).toEqual({ type: 'between_tools' });
    expect(r.output_config.effort).toBeUndefined();
    const low = buildRequest(plan, fxPinned, cat, rungs[1] as unknown as Rung, prompt);
    expect(low.thinking).toBeUndefined();
    expect(low.output_config.effort).toBe('low');
  });
  it('byte-identical twice for the same inputs', () => {
    expect(JSON.stringify(buildRequest(plan, fxPinned, cat, rung, prompt))).toBe(JSON.stringify(buildRequest(plan, fxPinned, cat, rung, prompt)));
  });
});

describe('5 shapeOnly', () => {
  const out = () => shapeOnly(bothSchema);
  const text = () => JSON.stringify(out());
  const walk = (n: unknown, f: (o: Record<string, unknown>) => void) => {
    if (Array.isArray(n)) n.forEach((x) => walk(x, f));
    else if (n && typeof n === 'object') { f(n as Record<string, unknown>); Object.values(n).forEach((x) => walk(x, f)); }
  };
  it('inlines every $ref, external and local', () => {
    expect(text()).not.toContain('$ref');
    expect(text()).not.toContain('$defs');
    expect((out() as any).properties.email.properties.subject.type).toBe('string');
    expect((out() as any).properties.landing_page.properties.sections.type).toBe('array');
  });
  it('drops refused keywords and metadata, oneOf becomes anyOf, slot an enum', () => {
    for (const k of ['oneOf', 'minLength', 'maxLength', 'maxItems', 'pattern', '$id', '$schema']) expect(text()).not.toContain(`"${k}"`);
    const secs = (out() as any).properties.landing_page.properties.sections;
    expect(secs.items.anyOf).toHaveLength(7);
    expect(secs.items.anyOf[0].properties.slot).toEqual({ type: 'string', enum: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] });
  });
  it('minItems above 1 goes, every object closed and fully required', () => {
    walk(out(), (o) => {
      if ('minItems' in o) expect(o.minItems).toBeLessThanOrEqual(1);
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
    });
  });
  it('does not change the schema it was given', () => {
    expect(JSON.stringify(landingSchema)).toContain('"oneOf"');
    expect(JSON.stringify(bothSchema)).toContain('$ref');
  });
  it('an unknown $ref throws', () => {
    expect(() => shapeOnly({ $ref: 'nicobar/nope' })).toThrow(/nope/);
  });
});

describe('6b readPromptDir and canonicalContent', () => {
  const copyDir = (crlf: boolean) => {
    const d = mkdtempSync(join(tmpdir(), 'prompt-'));
    for (const f of ['role.md', 'voice-card.md', 'email.md', 'landing-v2.md', 'task.md', 'retry.md']) {
      const t = readFileSync(join(DIR, f), 'utf8');
      writeFileSync(join(d, f), crlf ? t.replace(/\n/g, '\r\n') : t);
    }
    return d;
  };
  // What a D1 row hands back: the same text, parsed from content_json.
  const fromD1 = (p: PromptFiles): PromptFiles => JSON.parse(canonicalContent(p));
  it('a dir with the same bytes gives the same prefix and canonicalContent as D1', () => {
    const dir = readPromptDir(copyDir(false));
    const d1 = fromD1(prompt);
    expect(assemblePrefix(dir, schemas)).toBe(assemblePrefix(d1, schemas));
    expect(canonicalContent(dir)).toBe(canonicalContent(d1));
  });
  it('CRLF normalises to LF', () => {
    const crlf = readPromptDir(copyDir(true));
    expect(crlf.role).not.toContain('\r');
    expect(canonicalContent(crlf)).toBe(canonicalContent(prompt));
    expect(assemblePrefix(crlf, schemas)).toBe(assemblePrefix(prompt, schemas));
    const raw: PromptFiles = { ...prompt, role: prompt.role.replace(/\n/g, '\r\n') };
    expect(canonicalContent(raw)).toBe(canonicalContent(prompt));
    expect(assemblePrefix(raw, schemas)).toBe(assemblePrefix(prompt, schemas));
  });
  it('fixed key order whatever order the object was built in', () => {
    const shuffled = Object.fromEntries(Object.entries(prompt).reverse()) as unknown as PromptFiles;
    expect(canonicalContent(shuffled)).toBe(canonicalContent(prompt));
  });
  it('JevConfig too, nested keys included', () => {
    const a = { version: 'x', act: { b: false, a: false } } as never;
    const b = { act: { a: false, b: false }, version: 'x' } as never;
    expect(canonicalContent(a)).toBe(canonicalContent(b));
  });
});
