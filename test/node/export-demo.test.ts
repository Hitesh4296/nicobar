// lane ship, part 1: tests 2, 4, 4a, 4b on fixtures, with `transition` faked. Test 1 on the real `transition` is part 2.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOSTS } from '../../scripts/predeploy-check.ts';
import { MAX_STATEMENT, RESET_TABLES, buildSeed, exportFromCopy, leakErrors, pinsRefusal, pruneSql, query, r2Keys, selectRuns,
  wrangler } from '../../scripts/export-demo.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const TSV = readFileSync(join(ROOT, 'data/customers.nicobar.tsv'), 'utf8');

describe('active versions must equal the pins of F', () => {
  const f = { id: 'run-f', prompt_version: 'v2', jev_config_version: 'jev-v1' };
  const active = (prompt: string, jev: string) => [{ id: prompt, kind: 'prompt' }, { id: jev, kind: 'jev' }];
  it('equal passes', () => expect(pinsRefusal(f, active('v2', 'jev-v1'))).toEqual([]));
  it('a newer prompt refuses', () => expect(pinsRefusal(f, active('v3', 'jev-v1'))[0]).toMatch(/prompt/));
  it('a newer jev refuses', () => expect(pinsRefusal(f, active('v2', 'jev-v2'))[0]).toMatch(/jev/));
  it('no active row refuses', () => expect(pinsRefusal(f, [])).toHaveLength(2));
});

describe('test 2: a DEV_* var fails the pre-deploy command', () => {
  const CLEAN = { workers_dev: false, preview_urls: false, routes: HOSTS.map((pattern) => ({ pattern, custom_domain: true })), d1_databases: [{ database_id: 'x' }],
    vars: { DEPLOYED: '1', TEAM_DOMAIN: 'https://t.test', ACCESS_AUD: 'aud', PUBLIC_ORIGIN: 'https://landing.hiteshnarwal.in' } };
  const run = (vars: object, over: object = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'predeploy-'));
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ env: { demo: { ...CLEAN, ...over, vars: { ...CLEAN.vars, ...vars } } } }));
    return spawnSync(process.execPath, [join(ROOT, 'scripts/predeploy-check.ts')], { cwd: dir, encoding: 'utf8' });
  };
  it('clean passes', () => expect(run({}).status).toBe(0));
  it('no AUD fails', () => expect(run({ ACCESS_AUD: '' }).stderr).toContain('ACCESS_AUD'));
  it('a wrong public origin fails', () => expect(run({ PUBLIC_ORIGIN: 'https://nicobar.hiteshnarwal.in' }).stderr).toContain('PUBLIC_ORIGIN'));
  it('workers.dev on fails: that host is outside Access', () => expect(run({}, { workers_dev: true }).stderr).toContain('workers_dev'));
  it('a missing custom domain fails', () => expect(run({}, { routes: [] }).stderr).toContain('landing.hiteshnarwal.in'));
  for (const v of ['DEV_MODE', 'DEV_ACTOR', 'DEV_FAULT', 'DEV_ANYTHING']) {
    it(`${v} exits 1`, () => { const r = run({ [v]: 'x' }); expect(r.status).toBe(1); expect(r.stderr).toContain(v); });
  }
});

describe('test 4: no last name, no whole note', () => {
  it('first name alone passes', () => expect(leakErrors("Dear Meera, 'for Sister''s wedding'", TSV)).toEqual([]));
  it('a last name fails', () => expect(leakErrors('Dear Modi', TSV)).toEqual(['last name: Modi']));
  it('first and last fails even for a word the site also uses', () => expect(leakErrors('Dear Neel Patel', TSV)).toEqual(['last name: Neel Patel']));
  it('a site word alone does not fail', () => expect(leakErrors('with Patel and Singh and the Palace', TSV)).toEqual([]));
  it('a one-letter last name fails only beside the first name', () => {
    expect(leakErrors('S size in Sara', TSV)).toEqual([]);
    expect(leakErrors('sara s', TSV)).toEqual(['last name: Sara S']);
  });
  it('a whole note fails', () => {
    expect(leakErrors('x Bought the cotton drape kurta before a work trip. y', TSV)).toEqual([expect.stringMatching(/^whole note: c02/)]);
  });
  it('a whole note fails through SQL and HTML escaping', () => {
    const tsv = "customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\nc1\tA\t\tx\tMum's old shawl, kept for years.\n";
    expect(leakErrors("x Mum''s old shawl, kept for years. y", tsv)).toHaveLength(1);
    expect(leakErrors('x Mum&#39;s old shawl, kept for years. y', tsv)).toHaveLength(1);
  });
  it('c8n spans are exempt only where passed', () => {
    const tsv = 'customer_id\tfirst_name\tlast_name\toccasion\tpast_purchase_note\nc1\tA\tModi\tx\t\n';
    expect(leakErrors('"Modi shirt"', tsv, ['Modi shirt'])).toEqual([]);
    expect(leakErrors('"Modi shirt"', tsv)).toHaveLength(1);
  });
  it('the demo bundle holds neither', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    execFileSync(join(ROOT, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--env', 'demo', '--outdir', dir],
      { cwd: ROOT, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    const spans = Object.values(JSON.parse(readFileSync(join(ROOT, 'config/lists/c8n.json'), 'utf8')) as Record<string, string[]>).flat();
    expect(leakErrors(readFileSync(join(dir, 'index.js'), 'utf8'), TSV, spans)).toEqual([]);
  }, 60_000);
});

describe('test 4a: statement cap', () => {
  const big = `INSERT INTO "drafts" ("id","rendered_json","model_json") VALUES('d''1',replace('${"a''₹\\n".repeat(60_000)}','\\n',char(10)),'{}');`;
  it('over the cap, a table with no key is refused, not cut', () => {
    expect(() => buildSeed(`INSERT INTO "units" ("run_id","error_detail") VALUES('r','${'x'.repeat(120_000)}');`)).toThrow(/units/);
  });
  it('splits on a character, never inside a doubled quote', () => {
    const { statements, largest } = buildSeed(big);
    expect(largest).toBeLessThanOrEqual(MAX_STATEMENT);
    const updates = statements.filter((s) => s.startsWith('UPDATE'));
    expect(updates.length).toBeGreaterThan(1);
    for (const u of updates) {
      expect(Buffer.byteLength(u)).toBeLessThanOrEqual(MAX_STATEMENT);
      const lit = /\|\| '([\s\S]*)' WHERE/.exec(u)![1];
      expect(lit.replaceAll("''", '')).not.toContain("'");
    }
  });
  it('a small statement passes through unchanged', () => {
    const s = `INSERT INTO "snapshots" ("id") VALUES('s');`;
    expect(buildSeed(`PRAGMA defer_foreign_keys=TRUE;\n${s}`).statements.at(-1)).toBe(s);
  });
  it('a table outside the list is refused', () => {
    expect(() => buildSeed(`INSERT INTO "ledger_manual" ("id") VALUES(1);`)).toThrow(/ledger_manual/);
    expect(() => buildSeed('DROP TABLE drafts;')).toThrow(/unexpected/);
  });
  it('opens with DELETE of every seeded table, jev_dismissals and config_versions named', () => {
    const { sql } = buildSeed('');
    expect(RESET_TABLES).toEqual(expect.arrayContaining(['jev_dismissals', 'config_versions', 'snapshots', 'runs', 'units', 'plans', 'drafts',
      'draft_events', 'cost_events', 'jev_events', 'generations']));
    expect(sql.trim().split('\n')).toEqual(RESET_TABLES.map((t) => `DELETE FROM "${t}";`));
  });
});

describe('R2 for the link', () => {
  it('each seeded snapshot: the two the Worker cannot start without, then the side files, and no customer file', () => {
    expect(r2Keys(['s1'])).toEqual({ required: ['snapshots/s1/catalog.json', 'snapshots/s1/rules.json'],
      optional: ['snapshots/s1/report.json', 'snapshots/s1/detail.json', 'snapshots/s1/vocabulary.json'] });
  });
});

describe('never touches anything remote', () => {
  it('the script holds no remote flag and no deploy', () => {
    const src = readFileSync(join(ROOT, 'scripts/export-demo.ts'), 'utf8');
    expect(src).not.toMatch(/--remote|'deploy'|"deploy"/);
  });
});

// 46 §2. `agents` adds these by 0002; IF NOT EXISTS keeps this file true after that merge.
const CONFIG_DDL = `CREATE TABLE IF NOT EXISTS config_versions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT NULL, content_json TEXT NOT NULL, sha256 TEXT NOT NULL,
  base_sha256 TEXT NOT NULL, voice_guide_version TEXT NULL, status TEXT NOT NULL, note TEXT NOT NULL, created_kind TEXT NOT NULL, created_by TEXT NOT NULL,
  created_sub TEXT NOT NULL, created_at TEXT NOT NULL, activated_by TEXT NULL, activated_sub TEXT NULL, activated_at TEXT NULL, validation_json TEXT NULL);
CREATE TABLE IF NOT EXISTS jev_dismissals (run_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempt INTEGER NOT NULL, question TEXT NOT NULL, actor_kind TEXT NOT NULL,
  actor_email TEXT NOT NULL, actor_sub TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY (run_id, customer_id, attempt, question));`;

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sha = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

function runSql(id: string, stage: string, snapshot: string, prompt: string) {
  return `INSERT INTO runs (id, instance_id, stage, format, snapshot_id, run_date, customers_sha256, customers_r2_key, customers_synthetic, recs_sha256, setting, prompt_version,
    voice_guide_version, shapes_sha256, jev_model, jev_config_version, cap_run_usd, ceiling_usd, preview_sha256, expected_usd, status, created_by, created_at)
    VALUES (${q(id)}, ${q(id)}, ${q(stage)}, 'both', ${q(snapshot)}, '2026-11-01', 'c', 'k', 1, 'r', 's', ${q(prompt)}, ${q(prompt)}, 'sh', 'jev', 'jev-v1', 1, 1, 'p', 0.79, 'done', 'o', ${q(`2026-11-01T${stage === 'F' ? '10' : '09'}:00:00Z`)});`;
}
const unitSql = (run: string, c: string) => `INSERT INTO units (run_id, customer_id, status, billed_attempts) VALUES (${q(run)}, ${q(c)}, 'drafted', 1);`;
function draftSql(run: string, c: string, rendered: string) {
  const env = '{"customer_id":"it\'s","x":"a\\nb"}', model = 'line one\nline two\r\nthree';
  return `INSERT INTO plans (run_id, customer_id, plan_json, created_at) VALUES (${q(run)}, ${q(c)}, '{}', 't');
INSERT INTO generations (run_id, customer_id, attempt, result_type, message_json) VALUES (${q(run)}, ${q(c)}, 1, 'answered', ${q(`{"gen":"${run}"}`)});
INSERT INTO cost_events (run_id, customer_id, attempt, setting, action, call_state, at) VALUES (${q(run)}, ${q(c)}, 1, 's', 'admit', 'estimated', 't');
INSERT INTO jev_events (run_id, customer_id, attempt, model_requested, status, reason, basis_usd, at) VALUES (${q(run)}, ${q(c)}, 1, 'j', 'below_gate', 'x', 0, 't');
INSERT INTO draft_events (draft_id, to_status, actor_kind, at, content_sha256, edge_nonce) VALUES (${q(`${run}:${c}:v1`)}, 'in_review', 'system', 't', 'h', 'n');
INSERT INTO drafts (id, run_id, customer_id, version, format, snapshot_id, validator_version, model, envelope_json, model_json, rendered_json, content_sha256, checks_json, hard_failures, status)
  VALUES (${q(`${run}:${c}:v1`)}, ${q(run)}, ${q(c)}, 1, 'both', 'snap', 'v', 'm', ${q(env)}, ${q(model)}, ${q(rendered.slice(0, 50_000))}, ${q(sha(env, model, rendered))}, '[]', 0, 'in_review');
${Array.from({ length: Math.ceil(rendered.length / 50_000) }, (_, i) => i).slice(1).map((i) =>   // SQLite refuses a longer statement, local too
    `UPDATE drafts SET rendered_json = rendered_json || ${q(rendered.slice(i * 50_000, (i + 1) * 50_000))} WHERE id = ${q(`${run}:${c}:v1`)};`).join('\n')}`;
}
const version = (id: string, kind: string, status: string) => `INSERT INTO config_versions (id, kind, content_json, sha256, base_sha256, voice_guide_version, status, note, created_kind,
  created_by, created_sub, created_at, activated_by, activated_sub, activated_at) VALUES (${q(id)}, ${q(kind)}, '{}', 'x', 'y', ${kind === 'prompt' ? q(id) : 'NULL'}, ${q(status)}, 'n', 'dev', 'a', 'b', 't', 'a', 'b', 't');`;

describe('fixture export through real local wrangler (tests 4, 4a, 4b, seed twice)', () => {
  const big = JSON.stringify({ email: `<p>₹ it's "q"</p>\n`.repeat(12_000), catalog: 'x' });
  let source: string, target: string, seed: ReturnType<typeof buildSeed>;

  const dir = (name: string) => {
    const d = mkdtempSync(join(tmpdir(), `${name}-`));
    const cfg = join(d, 'wrangler.jsonc');
    writeFileSync(join(d, 'w.js'), 'export default { fetch() { return new Response("x"); } }');
    cpSync(join(ROOT, 'migrations'), join(d, 'migrations'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ name: 'x', main: 'w.js', compatibility_date: '2026-10-23', d1_databases: [{ binding: 'DB', database_name: 'nicobar',
      database_id: 'nicobar-local', migrations_dir: 'migrations' }] }));
    wrangler(cfg, 'd1', 'migrations', 'apply', 'nicobar', '--local');
    writeFileSync(join(d, 'ddl.sql'), CONFIG_DDL);
    wrangler(cfg, 'd1', 'execute', 'nicobar', '--local', '--file', join(d, 'ddl.sql'));
    return cfg;
  };
  const file = (cfg: string, name: string, sql: string) => {
    const p = join(cfg, '..', name);
    writeFileSync(p, sql);
    wrangler(cfg, 'd1', 'execute', 'nicobar', '--local', '--file', p);
  };

  beforeAll(() => {
    source = dir('source');
    target = dir('target');
    file(source, 'rows.sql', [
      `INSERT INTO snapshots VALUES ('snap', '2026-10-29', 16069, 2180, 0), ('fx-snapshot', '2026-10-29', 1, 1, 1);`,
      runSql('run-f', 'F', 'snap', 'v2'), runSql('stub-f', 'F', 'snap', 'v2').replace('T10:', 'T11:'), runSql('run-iso', 'isolation', 'snap', 'v2'), runSql('run-voice', 'voice', 'snap', 'v1'), runSql('fx-run', 'F', 'fx-snapshot', 'v1'),
      unitSql('run-f', 'c01'), unitSql('run-f', 'c02'), unitSql('run-iso', 'c20-x'), unitSql('run-voice', 'c01'), unitSql('fx-run', 'fx-both'),
      draftSql('run-f', 'c01', big), draftSql('run-f', 'c02', '{"email":"small"}'), draftSql('run-iso', 'c20-x', '{}'), draftSql('run-voice', 'c01', '{"email":"voice-only-row"}'),
      draftSql('fx-run', 'fx-both', '{"email":"fixture-only-row"}'),
      version('v1', 'prompt', 'retired'), version('v2', 'prompt', 'active'), version('v9', 'prompt', 'draft').replace("'a', 'b', 't');", 'NULL, NULL, NULL);'), version('jev-v1', 'jev', 'active'),
      version('rank-v1', 'rank', 'retired'), version('rank-v2', 'rank', 'active'), version('catalog-v1', 'catalog', 'retired'), version('catalog-v9', 'catalog', 'retired'),
      `UPDATE runs SET ranking_version = 'rank-v1', catalog_version = 'catalog-v1' WHERE id = 'run-f';`,
    ].join('\n'));
    const runs = selectRuns(source);
    expect(runs).toMatchObject({ f: { id: 'run-f' }, isolation: { id: 'run-iso' } });
    seed = exportFromCopy(source, runs, TSV, []);
    file(target, 'seed.sql', seed.sql);
  }, 120_000);

  it('test 4a: largest statement within the cap though one draft is over 200 KB', () => {
    expect(Buffer.byteLength(big)).toBeGreaterThan(200_000);
    expect(seed.largest).toBeLessThanOrEqual(MAX_STATEMENT);
    expect(seed.statements.some((s) => s.startsWith('UPDATE "drafts" SET "rendered_json"'))).toBe(true);
  });
  it('test 4b: no voice or fixture row, though the source has them', () => {
    expect(query(source, `SELECT COUNT(*) AS n FROM runs`)).toEqual([{ n: 2 }]);   // the copy, pruned
    expect(seed.sql).not.toMatch(/voice-only-row|fixture-only-row|run-voice|fx-run|fx-snapshot/);
  });
  it('isolation keeps runs and units only', () => {
    expect(query(target, `SELECT COUNT(*) AS n FROM units WHERE run_id = 'run-iso'`)).toEqual([{ n: 1 }]);
    for (const t of ['plans', 'drafts', 'cost_events', 'jev_events', 'generations']) expect(query(target, `SELECT COUNT(*) AS n FROM ${t} WHERE run_id = 'run-iso'`)).toEqual([{ n: 0 }]);
    expect(query(target, `SELECT COUNT(*) AS n FROM draft_events WHERE draft_id LIKE 'run-iso%'`)).toEqual([{ n: 0 }]);
  });
  it('config_versions holds what the seeded runs pin and what is active, nothing else', () => {
    expect(query<{ id: string }>(target, 'SELECT id FROM config_versions ORDER BY id').map((r) => r.id)).toEqual(['catalog-v1', 'jev-v1', 'rank-v1', 'rank-v2', 'v2']);
  });
  it('generations ship for the F run, and no other', () => {
    expect(query<{ run_id: string; message_json: string }>(target, 'SELECT run_id, message_json FROM generations ORDER BY customer_id')).toEqual([
      { run_id: 'run-f', message_json: '{"gen":"run-f"}' }, { run_id: 'run-f', message_json: '{"gen":"run-f"}' }]);
  });
  it('seed applied twice reproduces every content_sha256 and clears dismissals', () => {
    const dump = () => query<Record<string, string>>(target, 'SELECT id, envelope_json, model_json, rendered_json, content_sha256 FROM drafts ORDER BY id');
    const check = () => {
      const rows = dump();
      expect(rows.map((r) => r.id)).toEqual(['run-f:c01:v1', 'run-f:c02:v1']);
      for (const r of rows) expect(sha(r.envelope_json, r.model_json, r.rendered_json)).toBe(r.content_sha256);
      expect(rows[0].rendered_json).toBe(big);
    };
    check();
    wrangler(target, 'd1', 'execute', 'nicobar', '--local', '--command',
      `INSERT INTO jev_dismissals VALUES ('run-f', 'c01', 1, 'q', 'human', 'a', 'b', 't', 'judge note');`);
    wrangler(target, 'd1', 'execute', 'nicobar', '--local', '--file', join(target, '..', 'seed.sql'));
    check();
    expect(query(target, 'SELECT COUNT(*) AS n FROM jev_dismissals')).toEqual([{ n: 0 }]);
  }, 60_000);
  it('a last name in a row refuses the export, before any chunk could split it', () => {
    const leaky = dir('leaky');
    file(leaky, 'rows.sql', [`INSERT INTO snapshots VALUES ('snap', '2026-10-29', 1, 1, 0);`, runSql('run-f', 'F', 'snap', 'v2'), runSql('run-iso', 'isolation', 'snap', 'v2'),
      draftSql('run-f', 'c01', `${'x'.repeat(89_990)} Dear Modi ${'x'.repeat(89_990)}`), version('v2', 'prompt', 'active'), version('jev-v1', 'jev', 'active')].join('\n'));
    expect(() => exportFromCopy(leaky, selectRuns(leaky), TSV, [])).toThrow(/Modi/);
  }, 60_000);
  it('a cell d1 export would change refuses the export', () => {
    const mixed = dir('mixed');
    file(mixed, 'rows.sql', [`INSERT INTO snapshots VALUES ('snap', '2026-10-29', 1, 1, 0);`, runSql('run-f', 'F', 'snap', 'v2'), runSql('run-iso', 'isolation', 'snap', 'v2'),
      draftSql('run-f', 'c01', 'real\nnewline and literal \\n'), version('v2', 'prompt', 'active'), version('jev-v1', 'jev', 'active')].join('\n'));
    expect(() => exportFromCopy(mixed, selectRuns(mixed), TSV, [])).toThrow(/drafts\.rendered_json: 1/);
  }, 60_000);
  it('prune keeps both runs by id, quoted', () => expect(pruneSql("a'b", 'c')).toContain("'a''b'"));
  it('prune keeps the drafts of every run with a release', () => expect(pruneSql('f', 'i', ['v'])).toContain("DELETE FROM drafts WHERE run_id NOT IN ('f', 'v');"));
});
