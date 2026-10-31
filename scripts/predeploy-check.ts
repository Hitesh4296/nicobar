// Runs before any deploy. Any DEV_* in a var fails it.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

interface Vars { vars?: Record<string, string>; d1_databases?: { database_id?: string }[] }
export function predeployErrors(cfg: Vars & { env?: Record<string, Vars> }): string[] {
  const scopes: [string, Vars][] = [['top level', cfg], ...Object.entries(cfg.env ?? {})];
  const errors = scopes.flatMap(([name, s]) =>
    Object.keys(s.vars ?? {}).filter((k) => k.startsWith('DEV_')).map((k) => `${k} set in ${name}`));
  const demo = cfg.env?.demo;
  if (demo?.vars?.DEPLOYED !== '1') errors.push('env.demo must set DEPLOYED=1');
  if (!demo?.vars?.TEAM_DOMAIN) errors.push('env.demo must set TEAM_DOMAIN');
  if (!demo?.d1_databases?.length || demo.d1_databases.some((d) => !d.database_id)) errors.push('env.demo must set a D1 database_id');
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = predeployErrors(JSON.parse(readFileSync('wrangler.jsonc', 'utf8')));   // kept comment-free for this
  for (const e of errors) console.error(`predeploy: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
