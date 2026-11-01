// npm run demo: migrate, build from samples/site, seed config, one run through the real Workflow on the local stub, then keep serving. No key to set up, $0, nothing remote.
// The server gets a random run key made for this launch: on the command line to wrangler and in memory here, never printed, never on disk. .dev.vars stays closed.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cap from '../config/cap.json' with { type: 'json' };
import type { CapConfig } from '../src/contracts/types.ts';
import { batch } from './batch.ts';
import { startStub } from './stub-llm.ts';

const PORT = Number(process.env.PORT ?? 8787);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** cap.json's S is a placeholder for real count_tokens, and the stub counts chars ÷ 4 of a bigger prompt, which would skip everyone as OVER_CAP. So it answers one design-size call. */
export const stubCount = (n: number, c: CapConfig) => Math.min(n, c.S.both + 1000);

/** An empty --env-file keeps .dev.vars, and any real key in it, away from this server. */
export const devArgs = (port: number, stubPort: number, envFile: string, runKey: string) => ['wrangler', 'dev', '--port', String(port), '--env-file', envFile,
  ...['DEV_MODE:1', 'DEV_ACTOR:dev@local', `RUN_KEY:${runKey}`, 'ANTHROPIC_API_KEY:stub', `ANTHROPIC_BASE_URL:http://127.0.0.1:${stubPort}`].flatMap((v) => ['--var', v])];

async function main() {
  // A real key in the shell stays out of every client here, and a shell RUN_KEY is not this server's.
  process.env.ANTHROPIC_API_KEY = 'stub'; delete process.env.RUN_KEY;
  const url = `http://localhost:${PORT}`, env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }, runKey = randomBytes(32).toString('hex');
  execFileSync('node', ['scripts/check-config.ts'], { stdio: 'inherit' });
  execFileSync('node', ['scripts/build.ts', '--publish'], { stdio: 'inherit', env });
  const stub = await startStub(0, { key: 'stub', count: (n) => stubCount(n, cap as unknown as CapConfig) });   // port 0: any free one
  const stubPort = (stub.address() as AddressInfo).port;
  mkdirSync('out', { recursive: true }); writeFileSync('out/empty.env', '');
  const dev = spawn('npx', devArgs(PORT, stubPort, resolve('out/empty.env'), runKey), { stdio: 'inherit', env, detached: true });
  const stop = () => { stub.close(); try { process.kill(-dev.pid!, 'SIGTERM'); } catch { /* gone */ } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  dev.on('exit', (code) => { console.error(`wrangler dev exited ${code}. Is port ${PORT} taken?`); stub.close(); process.exit(1); });
  for (let i = 0; i < 120 && !await fetch(`${url}/review`).catch(() => null); i++) await sleep(500);

  execFileSync('node', ['scripts/config.ts', 'seed'], { stdio: 'inherit', env: { ...env, CONFIG_URL: url } });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stubPort}`;   // so the preview stays on the stub too
  const id = await batch({ stage: 'rehearsal', format: 'both' }, url, runKey);
  for (let i = 0; i < 300; i++) {
    const page = await (await fetch(`${url}/review?run=${id}`)).text();
    if (/· (done|stopped) ·/.test(page)) { console.log(`\nDemo ready: ${url}/review?run=${id}\nStub drafts, labelled as stub. Approve and publish work. Ctrl-C to stop.\n`); return; }
    await sleep(1000);
  }
  throw new Error(`run ${id} not finished in 5 minutes: ${url}/review?run=${id}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
