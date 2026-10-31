import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fxActiveVersions, fxEvalValidity, fxFlagRow, fxLoadVersion } from '../fakes/config.ts';

const db = () => { const d = new DatabaseSync(':memory:'); d.exec(readFileSync('migrations/0002_config.sql', 'utf8')); return d; };
const ins = (d: DatabaseSync, id: string, status: string) => d.prepare(
  `INSERT INTO config_versions (id, kind, content_json, sha256, base_sha256, voice_guide_version, status, note, created_kind, created_by, created_sub,
    created_at, activated_by, activated_sub, activated_at, validation_json) VALUES (?, 'prompt', '{}', 'h', 'b', 'v1', ?, 'n', 'dev', 'e', 's', 't', ?, ?, ?, ?)`)
  .run(id, status, ...(status === 'draft' ? [null, null, null, null] : ['e', 's', 't', '{}']));

describe('0002_config.sql', () => {
  it('one_active refuses a second active of a kind', () => {
    const d = db(); ins(d, 'v1', 'active');
    expect(() => ins(d, 'v2', 'active')).toThrow(/UNIQUE/);
    ins(d, 'v2', 'retired');
  });
  it('a draft cannot carry activation fields, nor an active lack them', () => {
    const d = db(); ins(d, 'v1', 'draft');
    expect(() => d.prepare(`UPDATE config_versions SET status = 'active' WHERE id = 'v1'`).run()).toThrow(/CHECK/);
  });
  it('a dismissal needs a note and one row per question', () => {
    const d = db(); const add = (note: string) => d.prepare(`INSERT INTO jev_dismissals VALUES ('r', 'c', 1, 'quiet', 'dev', 'e', 's', 't', ?)`).run(note);
    expect(() => add('  ')).toThrow(/CHECK/);
    add('ok');
    expect(() => add('again')).toThrow(/UNIQUE/);
  });
});

describe('config fakes', () => {
  it('active pair matches what fxPinned pins', async () => {
    const a = await fxActiveVersions();
    expect([a.prompt.id, a.jev.id]).toEqual(['v1', 'jev-v1']);
    expect((await fxLoadVersion('jev-v1')).kind).toBe('jev');
  });
  it('unknown id fails as CONFIG_MISSING', async () => {
    await expect(fxLoadVersion('v9')).rejects.toThrow('CONFIG_MISSING');
  });
  it('evalValidity starts at no_run_yet', async () => {
    expect((await fxEvalValidity()).map((v) => v.state)).toEqual(['no_run_yet', 'no_run_yet']);
  });
  it('flagRow escapes the question and the note', () => {
    const html = fxFlagRow('<q>', true, { actor_email: 'a@b', at: 't', note: '<script>' });
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<q>');
  });
});
