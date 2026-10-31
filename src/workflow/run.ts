// One instance per run, 46 §7, LLD:1432. A step that runs out of retries is caught per customer, so one customer never ends the run.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { AppEnv, RunFormat } from '../contracts/types.ts';
import { admit, close, estimate, failUnit, finish, gen, genFailed, log, pin, prep } from './steps.ts';

const JEV_STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' } as const;   // [assume]
const GEN_STEP = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;

async function timed<T>(run_id: string, step: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const out = await fn();
    log({ run_id, key, step, status: 'ok', ms: Date.now() - t });
    return out;
  } catch (e) {
    log({ run_id, key, step, status: 'error', code: 'INTERNAL_ERROR', ms: Date.now() - t });
    throw e;
  }
}

export class RunWorkflow extends WorkflowEntrypoint<AppEnv, { run_id: string }> {
  override async run(event: WorkflowEvent<{ run_id: string }>, step: WorkflowStep): Promise<void> {
    const { run_id } = event.payload; const env = this.env;
    const { keys } = await step.do('pin', () => timed(run_id, 'pin', undefined, () => pin(env, run_id)));

    const estimates: Record<string, number | null> = {};
    for (const key of keys) {
      try {
        const kind = await step.do(`prep:${key}`, JEV_STEP, () => timed(run_id, 'prep', key, () => prep(env, run_id, key)));
        if (kind !== 'ready') continue;
        try {
          estimates[key] = await step.do(`est:${key}`, JEV_STEP, () => timed(run_id, 'est', key, () => estimate(env, run_id, key)));
        } catch { estimates[key] = null; }
      } catch (e) {
        await step.do(`fail-plan:${key}`, () => failUnit(env, run_id, key, e));
      }
    }

    const { admitted } = await step.do('admit', () => timed(run_id, 'admit', undefined, () => admit(env, run_id, estimates)));

    const genGroup = async ({ key }: { key: string; format: RunFormat }) => {
      try {
        for (let n: 1 | 2 | 0 = 1; n > 0;) {
          const a = n as 1 | 2;
          try {
            await step.do(`gen:${key}:${a}`, GEN_STEP, () => timed(run_id, 'gen', key, () => gen(env, run_id, key, a)));
          } catch {
            await step.do(`gen-failed:${key}:${a}`, () => genFailed(env, run_id, key, a));
          }
          const f = await step.do(`finish:${key}:${a}`, JEV_STEP, () => timed(run_id, 'finish', key, () => finish(env, run_id, key, a)));
          n = f.retry && a === 1 ? 2 : 0;
        }
      } catch (e) {
        await step.do(`fail-gen:${key}`, () => failUnit(env, run_id, key, e));
      }
    };

    // R71: the first call writes the cache alone. One format per run, so one warm call.
    const [warm, ...rest] = admitted;
    if (warm) await genGroup(warm);
    const size = Math.max(1, Number(env.GEN_CONCURRENCY) || 1);
    for (let i = 0; i < rest.length; i += size) await Promise.all(rest.slice(i, i + size).map(genGroup));

    await step.do('close', () => timed(run_id, 'close', undefined, () => close(env, run_id)));
  }
}
