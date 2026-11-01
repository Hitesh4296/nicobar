// Runs before any deploy. Any DEV_* in a var fails it.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

interface Vars { vars?: Record<string, string>; d1_databases?: { database_id?: string }[]; workers_dev?: boolean; preview_urls?: boolean; routes?: { pattern: string; custom_domain?: boolean }[] }
export const HOSTS = ['nicobar.hiteshnarwal.in', 'landing.hiteshnarwal.in'];
export function predeployErrors(cfg: Vars & { env?: Record<string, Vars> }): string[] {
  const scopes: [string, Vars][] = [['top level', cfg], ...Object.entries(cfg.env ?? {})];
  const errors = scopes.flatMap(([name, s]) =>
    Object.keys(s.vars ?? {}).filter((k) => k.startsWith('DEV_')).map((k) => `${k} set in ${name}`));
  const demo = cfg.env?.demo;
  const open = demo?.vars?.PUBLIC_DEMO === '1';   // R145: no Access, no read-only mode
  if (!open && demo?.vars?.DEPLOYED !== '1') errors.push('env.demo must set DEPLOYED=1');
  if (!open && !demo?.vars?.TEAM_DOMAIN) errors.push('env.demo must set TEAM_DOMAIN');
  if (!demo?.d1_databases?.length || demo.d1_databases.some((d) => !d.database_id)) errors.push('env.demo must set a D1 database_id');
  if (!open && !demo?.vars?.ACCESS_AUD) errors.push('env.demo must set ACCESS_AUD');
  if (demo?.vars?.PUBLIC_ORIGIN !== `https://${HOSTS[1]}`) errors.push(`env.demo PUBLIC_ORIGIN must be https://${HOSTS[1]}`);
  if (demo?.workers_dev !== false || demo?.preview_urls !== false) errors.push('env.demo must set workers_dev and preview_urls to false');
  for (const h of HOSTS) if (!demo?.routes?.some((r) => r.pattern === h && r.custom_domain)) errors.push(`env.demo must route ${h} as a custom domain`);
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = predeployErrors(JSON.parse(readFileSync('wrangler.jsonc', 'utf8')));   // kept comment-free for this
  for (const e of errors) console.error(`predeploy: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
