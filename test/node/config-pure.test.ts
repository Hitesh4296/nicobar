import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import jevJson from '../../config/jev.json' with { type: 'json' };
import type { FlagView, JevConfig, PromptFiles } from '../../src/contracts/types.ts';
import { fxCanonical, fxPrefix, fxSuffix } from '../fakes/config.ts';

vi.mock('../../src/lib/gen/canonical.ts', async () => ({ canonicalContent: (await import('../fakes/config.ts')).fxCanonical }));
vi.mock('../../src/lib/gen/index.ts', async () => {
  const f = await import('../fakes/config.ts');
  return { assemblePrefix: f.fxPrefix, renderSuffix: f.fxSuffix };
});
vi.mock('../../scripts/prompt-dir.ts', () => ({ readPromptDir: (d: string) => {
  const r = (n: string) => readFileSync(join(d, n), 'utf8');
  return { role: r('role.md'), voice_card: r('voice-card.md'), email: r('email.md'), landing: r('landing-v2.md'), task: r('task.md'), retry: r('retry.md') };
} }));

const { lineDiff, validateJev, validatePrompt } = await import('../../src/lib/config/index.ts');
const { BUNDLE, FX_CAT, FX_PLAN, sha256Hex } = await import('../../src/lib/config/bundle.ts');
const { flagRow, diffBlock } = await import('../../src/ui/agents/index.ts');
const { exportVersion, seed } = await import('../../scripts/config.ts');

const v1 = (): PromptFiles => {
  const r = (n: string) => readFileSync(`config/prompt/v1/${n}`, 'utf8');
  return { role: r('role.md'), voice_card: r('voice-card.md'), email: r('email.md'), landing: r('landing-v2.md'), task: r('task.md'), retry: r('retry.md') };
};
const vp = (f: PromptFiles) => validatePrompt(f, BUNDLE.schemas, FX_PLAN, FX_CAT);
const rulesOf = (r: { ok: boolean; failures?: { rule: string }[] }) => (r.ok ? [] : r.failures!.map((f) => f.rule));
const base = () => structuredClone(jevJson) as unknown as JevConfig;
const vj = (edit: (c: any) => void) => { const c = base(); edit(c); return rulesOf(validateJev(c, base())); };

describe('test 3: validatePrompt, each §13 rule', () => {
  it('staged v1 passes', () => expect(vp(v1())).toMatchObject({ ok: true }));
  const cases: [string, string, (f: PromptFiles) => void][] = [
    ['{{ in a prefix file', 'prefix_placeholder', (f) => { f.voice_card += ' {{name}}'; }],
    ['task missing a placeholder', 'task_placeholders', (f) => { f.task = f.task.replace('{{quotes}}', ''); }],
    ['task with an extra placeholder', 'task_placeholders', (f) => { f.task += '{{first_name}}'; }],
    ['retry with an extra placeholder', 'retry_placeholders', (f) => { f.retry += '{{note}}'; }],
    ['retry missing a placeholder', 'retry_placeholders', (f) => { f.retry = f.retry.replace('{{checks}}', ''); }],
    ['prefix over 18,000 bytes', 'prefix_size', (f) => { f.role += 'x'.repeat(19000); }],
    ['prefix under the floor', 'prefix_size', (f) => { f.role = 'x'; f.voice_card = 'x'; f.landing = 'x'; f.email = 'x'; }],
    ['a file carrying the schema heading', 'schema_heading', (f) => { f.email += '\n# Output schemas\n'; }],
    ['a key', 'secret', (f) => { f.role += ' sk-ant-abc'; }],
    ['a .dev.vars reference', 'secret', (f) => { f.task += ' .dev.vars'; }],
  ];
  for (const [name, rule, edit] of cases) it(`refuses ${name}`, () => {
    const f = v1(); edit(f);
    expect(rulesOf(vp(f))).toContain(rule);
  });
  it('a suffix that still holds {{ after rendering fails', () => {
    const f = v1(); f.task += '{{';   // unclosed, so not a placeholder the first rule sees
    expect(rulesOf(vp(f))).toContain('unrendered');
  });
});

describe('test 3 and 4: validateJev', () => {
  it('staged jev-v1 passes', () => expect(validateJev(base(), base())).toEqual({ ok: true }));
  it('version alone may differ', () => expect(vj((c) => { c.version = 'jev-v9'; })).toEqual([]));
  it('instructions, criteria and gates in range may differ', () => expect(vj((c) => {
    c.j3.discount.instructions = 'Does `email` offer a saving?'; c.j3.discount.criteria.true.what = 'x'; c.flag_gate = 0.3; c.score_flag_confidence = 0.8;
  })).toEqual([]));
  for (const [field, edit] of [['model', (c: any) => { c.model = 'other'; }], ['deadline_ms', (c: any) => { c.deadline_ms = 1; }],
    ['basis_usd', (c: any) => { c.basis_usd = 0; }], ['act_gate', (c: any) => { c.act_gate = 0.1; }],
    ['an unknown top field', (c: any) => { c.extra = 1; }]] as const)
    it(`locked: ${field}`, () => expect(vj(edit)).toContain('locked'));
  it('act true refused', () => expect(vj((c) => { c.act.discount = true; })).toContain('locked'));
  it('type changed refused', () => expect(vj((c) => { c.j3.quiet.type = 'noul'; })).toContain('locked'));
  it('bad changed refused', () => expect(vj((c) => { c.j3.scene.bad = true; })).toContain('locked'));
  it('question removed refused', () => expect(vj((c) => { delete c.j3.quiet; })).toContain('question_keys'));
  it('question added refused', () => expect(vj((c) => { c.j3.new_one = c.j3.quiet; })).toContain('question_keys'));
  it('a Noul side with no example refused', () => expect(vj((c) => { c.j3.discount.criteria.false.examples = []; })).toContain('noul_sides'));
  it('a Noul with one side refused', () => expect(vj((c) => { delete c.j3.discount.criteria.true; })).toContain('noul_sides'));
  it('a Score with 3 anchors refused', () => expect(vj((c) => { c.j3.quiet.criteria.pop(); })).toContain('score_anchors'));
  for (const v of [0.29, 0.71]) it(`flag_gate ${v} refused`, () => expect(vj((c) => { c.flag_gate = v; })).toContain('gate_range'));
  for (const v of [0.39, 0.81]) it(`score_flag_confidence ${v} refused`, () => expect(vj((c) => { c.score_flag_confidence = v; })).toContain('gate_range'));
  it('a backticked path outside J3Input refused', () => expect(vj((c) => { c.j3.claims_customer.instructions = 'Read `customer`.'; })).toContain('state_paths'));
  it('a garbage body fails, not throws', () => expect(rulesOf(validateJev({} as JevConfig, base())).length).toBeGreaterThan(0));
});

describe('lineDiff', () => {
  it('marks a changed line and keeps the rest', () => expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([{ op: '=', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: '=', text: 'c' }]));
  it('identical is all equal', () => expect(lineDiff('a\nb', 'a\nb').every((l) => l.op === '=')).toBe(true));
});

describe('test 9: escaping', () => {
  const evil = '<script>alert(1)</script>';
  it('diff output is escaped', () => {
    const html = diffBlock(lineDiff('a', evil));
    expect(html).not.toContain('<script>'); expect(html).toContain('&#60;script');
  });
  const f: FlagView = { question: '<q>', flagged: true, dismissal: { actor_email: '<a@b>', at: '<t>', note: evil } };
  it('flagRow note, actor and question are escaped', () => {
    const html = flagRow(f);
    for (const bad of ['<script>', '<q>', '<a@b>', '<t>']) expect(html).not.toContain(bad);
  });
  it('an open flag with a draft id posts to the encoded dismiss url', () => {
    const html = flagRow({ ...f, question: 'discount', dismissal: null }, 'r"1:c 1:v1');
    expect(html).toContain('action="/api/drafts/r%221%3Ac%201%3Av1/flags/discount/dismiss"');
  });
  it('no draft id, no form; a clear question offers none either', () => {
    expect(flagRow({ ...f, dismissal: null })).not.toContain('<form');
    expect(flagRow({ question: 'q', flagged: false, dismissal: null }, 'd')).not.toContain('<form');
  });
});

describe('test 10: config seed', () => {
  type Row = { id: string; kind: string; status: string; sha256: string; content: PromptFiles | JevConfig };
  let rows: Row[]; let calls: string[]; let allocate: ((kind: string) => string) | null;
  const api = async (method: 'GET' | 'POST', path: string, body?: any) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET') {
      const r = rows.find((x) => `/api/config/${x.id}` === path);
      return r ? { status: 200, json: r } : { status: 503, json: { code: 'CONFIG_MISSING' } };
    }
    if (path === '/api/config') {
      const n = rows.filter((r) => r.kind === body.kind).length + 1;
      const id = allocate?.(body.kind) ?? (body.kind === 'jev' ? `jev-v${n}` : `v${n}`);
      const row = { id, kind: body.kind, status: 'draft', sha256: await sha256Hex(fxCanonical(body.content)), content: body.content };
      rows.push(row);
      return { status: 200, json: row };
    }
    const r = rows.find((x) => path === `/api/config/${x.id}/activate`)!;
    rows.filter((x) => x.kind === r.kind && x.status === 'active').forEach((x) => { x.status = 'retired'; });
    r.status = 'active';
    return { status: 200, json: r };
  };
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), 'cfg-'));
    cpSync('config/prompt/v1', join(d, 'prompt/v1'), { recursive: true });
    cpSync('config/prompt/v1', join(d, 'prompt/v0'), { recursive: true });
    writeFileSync(join(d, 'jev.json'), JSON.stringify(jevJson));
    return d;
  };
  beforeEach(() => { rows = []; calls = []; allocate = null; });

  it('saves and activates v1 and jev-v1, skips v0', async () => {
    await seed(api, root());
    expect(rows.map((r) => [r.id, r.status])).toEqual([['v1', 'active'], ['jev-v1', 'active']]);
    expect(calls.join()).not.toContain('v0');
  });
  it('walks dirs in numeric order, each parent the one before', async () => {
    const d = root(); const seen: (string | null)[] = [];
    for (let n = 2; n <= 10; n++) { cpSync(join(d, 'prompt/v1'), join(d, `prompt/v${n}`), { recursive: true }); writeFileSync(join(d, `prompt/v${n}/role.md`), `r${n}`); }
    await seed((m, p, b) => { if (b?.kind === 'prompt') seen.push(b.parent_id); return api(m, p, b); }, d);
    expect(seen).toEqual([null, 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });
  it('a second seed changes nothing', async () => {
    const d = root(); await seed(api, d); calls = [];
    await seed(api, d);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });
  it('refuses a dir whose hash differs from its row', async () => {
    const d = root(); await seed(api, d);
    writeFileSync(join(d, 'prompt/v1/role.md'), 'changed');
    await expect(seed(api, d)).rejects.toThrow(/v1.*differs/);
  });
  it('allocated id must equal the file id', async () => {
    allocate = () => 'v7';
    await expect(seed(api, root())).rejects.toThrow(/v7/);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });
  it('a row left draft by a failed activation is activated', async () => {
    const d = root(); rows.push({ id: 'v1', kind: 'prompt', status: 'draft', sha256: await sha256Hex(fxCanonical((await import('../../scripts/prompt-dir.ts')).readPromptDir(join(d, 'prompt/v1')))), content: v1() });
    await seed(api, d);
    expect(rows[0].status).toBe('active');
  });
  it('picks up exported jev versions after jev.json', async () => {
    const d = root(); mkdirSync(join(d, 'jev'));
    writeFileSync(join(d, 'jev/jev-v2.json'), JSON.stringify({ ...jevJson, flag_gate: 0.4, version: 'jev-v2' }));
    await seed(api, d);
    expect(rows.map((r) => r.id)).toEqual(['v1', 'jev-v1', 'jev-v2']);
  });
  it('export then seed round-trips a prompt and a jev version', async () => {
    const d = root(); await seed(api, d);
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    await exportVersion(api, 'v1', out);
    expect(readdirSync(out).sort()).toEqual(['email.md', 'landing-v2.md', 'retry.md', 'role.md', 'task.md', 'voice-card.md']);
    expect(readFileSync(join(out, 'role.md'), 'utf8')).toBe(v1().role);
    await exportVersion(api, 'jev-v1', out);
    expect(JSON.parse(readFileSync(join(out, 'jev-v1.json'), 'utf8'))).toEqual(jevJson);
  });
});
