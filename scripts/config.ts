// config seed | import <path> | export <id> --out <dir>, through the local routes.
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalContent } from '../src/lib/gen/canonical.ts';
import { sha256Hex } from '../src/lib/config/bundle.ts';
import { readPromptDir } from './prompt-dir.ts';
import type { ConfigKind, ConfigVersion, JevConfig, PromptFiles } from '../src/contracts/types.ts';

type Answer = { status: number; json: any };
export type Api = (method: 'GET' | 'POST', path: string, body?: any) => Promise<Answer>;
const FILE_NAMES: Record<keyof PromptFiles, string> = { role: 'role.md', voice_card: 'voice-card.md', email: 'email.md', landing: 'landing-v2.md', task: 'task.md', retry: 'retry.md' };

async function must(a: Promise<Answer>): Promise<any> {
  const { status, json } = await a;
  if (status >= 300) throw new Error(`${status} ${json?.code ?? ''} ${JSON.stringify(json?.detail ?? '')}`);
  return json;
}
const read = async (api: Api, id: string): Promise<ConfigVersion | null> => {
  const { status, json } = await api('GET', `/api/config/${id}`);
  if (json?.code === 'CONFIG_MISSING') return null;
  if (status >= 300) throw new Error(`${status} ${json?.code}`);
  return json;
};

/** Every importable version in order. v0 never; jev-v1 is config/jev.json itself; later jev files come only from `export`. */
function targets(root: string): { id: string; kind: ConfigKind; content: PromptFiles | JevConfig; from: string }[] {
  const num = (s: string) => Number(s.match(/\d+/)![0]);
  const prompts = readdirSync(join(root, 'prompt')).filter((d) => /^v[1-9]\d*$/.test(d)).sort((a, b) => num(a) - num(b));
  const jevDir = join(root, 'jev');
  const jevs = existsSync(jevDir) ? readdirSync(jevDir).filter((f) => /^jev-v\d+\.json$/.test(f)).sort((a, b) => num(a) - num(b)) : [];
  const json = (p: string): JevConfig => JSON.parse(readFileSync(p, 'utf8'));
  return [...prompts.map((id) => ({ id, kind: 'prompt' as const, content: readPromptDir(join(root, 'prompt', id)), from: `prompt/${id}` })),
    { id: 'jev-v1', kind: 'jev' as const, content: json(join(root, 'jev.json')), from: 'jev.json' },
    ...jevs.map((f) => ({ id: f.replace('.json', ''), kind: 'jev' as const, content: json(join(jevDir, f)), from: `jev/${f}` }))];
}

export async function seed(api: Api, root: string): Promise<void> {
  const parent: Partial<Record<ConfigKind, string>> = {};
  for (const t of targets(root)) {
    const row = await read(api, t.id);
    const id = row?.id ?? (await must(api('POST', '/api/config', { kind: t.kind, parent_id: parent[t.kind] ?? null, content: t.content, note: `seed from config/${t.from}` }))).id;
    if (id !== t.id) throw new Error(`allocated ${id} for ${t.id}: refuse, the file and the table disagree`);
    if (row && row.sha256 !== await sha256Hex(canonicalContent(t.content))) throw new Error(`${t.id}: ${t.from} differs from its row, refuse`);
    if (!row || row.status === 'draft') await must(api('POST', `/api/config/${t.id}/activate`, {}));
    parent[t.kind] = t.id;
    console.log(`${t.id} ${row ? 'present' : 'seeded'}`);
  }
}

export async function importPath(api: Api, path: string): Promise<string> {
  const dir = statSync(path).isDirectory();
  const kind: ConfigKind = dir ? 'prompt' : 'jev';
  const active = await must(api('GET', '/api/config/active'));
  const content = dir ? readPromptDir(path) : JSON.parse(readFileSync(path, 'utf8'));
  return (await must(api('POST', '/api/config', { kind, parent_id: active[kind].id, content, note: `import ${path}` }))).id;
}

export async function exportVersion(api: Api, id: string, out: string): Promise<void> {
  const v: ConfigVersion = await must(api('GET', `/api/config/${id}`));
  mkdirSync(out, { recursive: true });
  if (v.kind === 'jev') { writeFileSync(join(out, `${id}.json`), `${JSON.stringify(v.content, null, 2)}\n`); return; }
  for (const [k, name] of Object.entries(FILE_NAMES)) writeFileSync(join(out, name), (v.content as PromptFiles)[k as keyof PromptFiles]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.CONFIG_URL ?? 'http://localhost:8787';
  const api: Api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const [cmd, arg, flag, out] = process.argv.slice(2);
  if (cmd === 'seed') await seed(api, 'config');
  else if (cmd === 'import' && arg) console.log(await importPath(api, arg));
  else if (cmd === 'export' && arg && flag === '--out' && out) await exportVersion(api, arg, out);
  else { console.error('usage: config seed | import <path> | export <id> --out <dir>'); process.exit(1); }
}
