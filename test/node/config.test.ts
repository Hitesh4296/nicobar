import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkConfig } from '../../scripts/check-config.ts';
import { predeployErrors } from '../../scripts/predeploy-check.ts';

const copyConfig = () => { const d = mkdtempSync(join(tmpdir(), 'cfg-')); cpSync('config', d, { recursive: true }); return d; };

describe('test 3: a landing key fails the build', () => {
  it('passes the staged keys', () => expect(checkConfig('config').errors).toEqual([]));
  for (const [file, edit] of [
    ['cap.json', (c: any) => { c.S.landing = 1; }],
    ['rungs.json', (r: any) => { r[0].max_tokens.landing = 1; }],
  ] as const) {
    it(`refuses it in ${file}, exit 1`, () => {
      const d = copyConfig();
      const json = JSON.parse(readFileSync(join(d, file), 'utf8'));
      edit(json);
      writeFileSync(join(d, file), JSON.stringify(json));
      expect(checkConfig(d).errors[0]).toMatch(/format key "landing"/);
      const r = spawnSync(process.execPath, ['scripts/check-config.ts', `--dir=${d}`]);
      expect(r.status).toBe(1);
    });
  }
});

describe('test 5: any DEV_* fails the pre-deploy check', () => {
  /** The real config with the two values only the owner can give. */
  const cfg = () => {
    const c = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    c.env.demo.vars.TEAM_DOMAIN = 'https://t.cloudflareaccess.com';
    c.env.demo.d1_databases[0].database_id = 'demo-db';
    return c;
  };
  it('passes a filled config', () => expect(predeployErrors(cfg())).toEqual([]));
  it('refuses an empty TEAM_DOMAIN and an empty database_id', () => {
    const c = cfg();
    c.env.demo.vars.TEAM_DOMAIN = '';
    c.env.demo.d1_databases[0].database_id = '';
    expect(predeployErrors(c)).toEqual(['env.demo must set TEAM_DOMAIN', 'env.demo must set a D1 database_id']);
  });
  it('refuses env.demo with no D1 binding', () => {
    const c = cfg();
    delete c.env.demo.d1_databases;
    expect(predeployErrors(c)).toEqual(['env.demo must set a D1 database_id']);
  });
  it('deploy:demo runs the guard before wrangler deploy', () => {
    const s = JSON.parse(readFileSync('package.json', 'utf8')).scripts['deploy:demo'] as string;
    expect(s).toBe('npm run predeploy:check && wrangler deploy --env demo');
  });
  for (const v of ['DEV_MODE', 'DEV_ACTOR', 'DEV_FAULT']) {
    it(`refuses ${v} in env.demo`, () => {
      const c = cfg();
      c.env.demo.vars[v] = '1';
      expect(predeployErrors(c)).toEqual([`${v} set in demo`]);
    });
    it(`refuses ${v} at top level`, () => {
      const c = cfg();
      c.vars[v] = '1';
      expect(predeployErrors(c)).toEqual([`${v} set in top level`]);
    });
  }
  it('refuses env.demo without DEPLOYED=1', () => {
    const c = cfg();
    delete c.env.demo.vars.DEPLOYED;
    expect(predeployErrors(c)).toContain('env.demo must set DEPLOYED=1');
  });
});
