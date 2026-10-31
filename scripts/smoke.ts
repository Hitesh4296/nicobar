// `npm run smoke`: main type-checks, bundles for both envs, and /review loads on a local server. No remote call.
import { execSync, spawn } from 'node:child_process';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });
run('npx tsc --noEmit');
run('npx wrangler deploy --dry-run --outdir out/smoke');
run('npx wrangler deploy --dry-run --env demo --outdir out/smoke-demo');

const port = 8799;
const dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--var', 'DEV_MODE:1', '--var', 'DEV_ACTOR:smoke@local'],
  { stdio: 'ignore', detached: true });
try {
  let res: Response | undefined;
  for (let i = 0; i < 60 && !res; i++) {
    res = await fetch(`http://127.0.0.1:${port}/review`).catch(() => undefined);
    if (!res) await new Promise((ok) => setTimeout(ok, 500));
  }
  if (res?.status !== 200) throw new Error(`/review answered ${res?.status}`);
  const spend = await fetch(`http://127.0.0.1:${port}/review/spend`);
  if (spend.status !== 200 || !(await spend.text()).includes('aria-current')) throw new Error('/review/spend missed demo');
  console.log('smoke ok: /review 200');
} finally {
  process.kill(-dev.pid!);
}
