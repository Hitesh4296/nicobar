// Fakes for the 46 §6 config functions, until src/lib/config merges. Same ids as fxPinned: v1, jev-v1.
import jev from '../../config/jev.json' with { type: 'json' };
import type { ConfigVersion, EvalValidity, PromptFiles } from '../../src/contracts/config.ts';
import type { JevConfig } from '../../src/contracts/types.ts';

const files: PromptFiles = { role: 'fx role', voice_card: 'fx voice', email: 'fx email', landing: 'fx landing',
  task: 'fx {{parts}} {{n}} {{occasion_key}} {{shape}} {{title_words}} {{title_words_email}} {{occasion}} {{picks}} {{quotes}}', retry: 'fx {{parts}} {{checks}}' };
const row = (id: string, kind: 'prompt' | 'jev', content: PromptFiles | JevConfig): ConfigVersion => ({ id, kind, parent_id: null, content,
  sha256: 'fx', base_sha256: 'fx', voice_guide_version: kind === 'prompt' ? id : null, status: 'active', note: 'fx', created_by: 'dev@local',
  created_at: '2026-11-01T00:00:00Z', activated_by: 'dev@local', activated_at: '2026-11-01T00:00:00Z' });
const rows: Record<string, ConfigVersion> = { v1: row('v1', 'prompt', files), 'jev-v1': row('jev-v1', 'jev', jev as unknown as JevConfig) };

export const fxActiveVersions = async () => ({ prompt: rows.v1, jev: rows['jev-v1'] });
export async function fxLoadVersion(id: string): Promise<ConfigVersion> {
  if (!Object.hasOwn(rows, id)) throw new Error('CONFIG_MISSING');
  return rows[id];
}
export const fxEvalValidity = async (): Promise<EvalValidity[]> => [
  { goal: 10, kind: 'prompt', active_id: 'v1', stages: ['F'], run_ids: [], state: 'no_run_yet' },
  { goal: 15, kind: 'jev', active_id: 'jev-v1', stages: ['F'], run_ids: [], state: 'no_run_yet' }];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fxFlagRow = (q: string, flagged: boolean, d: { actor_email: string; at: string; note: string } | null) =>
  `<li>${esc(q)} ${flagged ? 'flagged' : 'clear'}${d ? ` dismissed by ${esc(d.actor_email)} at ${esc(d.at)}: ${esc(d.note)}` : ''}</li>`;

// Stand-ins for gen and jev until they merge, for vi.mock. Gen's real serialiser is `canonicalContent`; this one is JSON too.
export const fxCanonical = (c: PromptFiles | JevConfig) => JSON.stringify(c);
export const fxPrefix = (f: PromptFiles, schemas: object[]) => [f.role, f.voice_card, f.email, f.landing, '# Output schemas', ...schemas.map((s) => JSON.stringify(s))].join('\n\n');
const fill = (t: string, names: string[]) => names.reduce((out, n) => out.replaceAll(`{{${n}}}`, n), t);
export const fxSuffix = (_p: unknown, _c: unknown, f: PromptFiles, retry?: unknown) =>
  fill(f.task, ['parts', 'n', 'occasion_key', 'shape', 'title_words', 'title_words_email', 'occasion', 'picks', 'quotes'])
  + (retry ? fill(f.retry, ['parts', 'checks']) : '');
/** answers = {question: number}, number is the bad-side reading against the config's gate: enough to tell two gates apart. */
export const fxFlagged = (answers: Record<string, unknown>, cfg: JevConfig) =>
  Object.keys(cfg.j3).filter((q) => typeof answers[q] === 'number' && (answers[q] as number) >= cfg.flag_gate);
