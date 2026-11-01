// npm run run-json -- <run_id> [--customer c01] [--state .wrangler/state/v3]: saves the run's JSON document to reports/runs/<id>.json. Reads local D1, writes no row. reports/runs is gitignored.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AppEnv } from '../src/contracts/types.ts';
import { runIn, trail } from '../src/worker/routes/review.ts';
import { runJson } from '../src/ui/run-json.ts';

const { values: v, positionals: [id] } = parseArgs({ allowPositionals: true, options: { customer: { type: 'string' }, state: { type: 'string', default: '.wrangler/state/v3' } } });
if (!id) throw new Error('usage: run-json <run_id> [--customer c01] [--state <dir>]');
const { getPlatformProxy } = await import('wrangler');
const proxy = await getPlatformProxy({ persist: { path: v.state! } });
try {
  const env = proxy.env as unknown as AppEnv;
  const run = await runIn(env, id);
  if (!run) throw new Error(`no run ${id}`);
  const doc = runJson(run, await trail(env, run, v.customer ?? null));
  mkdirSync('reports/runs', { recursive: true });
  const file = `reports/runs/${id}${v.customer ? `-${v.customer}` : ''}.json`;
  writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`wrote ${file}`);
} finally { await proxy.dispose(); }
