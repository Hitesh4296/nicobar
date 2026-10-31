// Runs before every wrangler build. `landing` as a key is the silent-NaN trap (LLD:475), so it is always fatal.
// Other drift from 46 §5 is listed; `--strict` makes it fatal, and turns on once G0's config lands.
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STAGES = ['F', 'Haiku', 'isolation', 'rehearsal', 'voice'];
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

function landingKeys(v: unknown, path: string, out: string[]): void {
  if (typeof v !== 'object' || v === null) return;
  for (const [k, c] of Object.entries(v)) {
    if (k === 'landing') out.push(`${path}.${k}`);
    landingKeys(c, `${path}.${k}`, out);
  }
}

export function checkConfig(dir: string): { errors: string[]; drift: string[] } {
  const errors: string[] = [];
  for (const f of ['cap.json', 'rungs.json', 'stages.json', 'prices.json']) landingKeys(read(dir, f), f, errors);
  const out = { errors: errors.map((e) => `format key "landing" at ${e}`), drift: [] as string[] };

  const cap = read(dir, 'cap.json');
  for (const k of ['S', 'U_design_max', 'U_hard']) if (!('both' in cap[k])) out.drift.push(`cap.json ${k} has no "both"`);
  for (const [k, v] of Object.entries(cap.E_out)) if (!('both' in (v as object))) out.drift.push(`cap.json E_out.${k} has no "both"`);
  if (String(cap.sha256).startsWith('PLACEHOLDER')) out.drift.push('cap.json sha256 is a placeholder');
  for (const r of read(dir, 'rungs.json')) if (!('both' in r.max_tokens)) out.drift.push(`rungs.json ${r.id} has no "both"`);
  const stages = Object.keys(read(dir, 'stages.json')).sort();
  if (stages.join() !== STAGES.join()) out.drift.push(`stages.json keys are ${stages.join()}, want ${STAGES.join()}`);
  const jev = read(dir, 'jev.json');
  for (const k of ['j2', 'j2_gate', 'vocabulary_order']) if (k in jev) out.drift.push(`jev.json still has ${k}`);
  if (!existsSync(join(dir, 'lists/c8n.json'))) out.drift.push('lists/c8n.json is absent');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, drift } = checkConfig(process.argv.find((a) => a.startsWith('--dir='))?.slice(6) ?? 'config');
  for (const d of drift) console.warn(`config drift: ${d}`);
  for (const e of errors) console.error(`config error: ${e}`);
  if (errors.length || (process.argv.includes('--strict') && drift.length)) process.exit(1);
}
