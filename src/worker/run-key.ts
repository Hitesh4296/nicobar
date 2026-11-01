// The key that starts a run. RUN_KEY lives in .dev.vars or a Wrangler secret. Never logged, stored, echoed or put in a URL: only `given` passes here, from a header or a POST body.
import type { AppEnv } from '../contracts/types.ts';

const MAX_WRONG = 5, WINDOW_MS = 15 * 60_000;
// ponytail: per isolate, so a restart clears it; ceiling is a guard against guessing on a local server. Durable Object if this is ever public.
let wrong: number[] = [];
export const resetRunKeyAttempts = () => { wrong = []; };

const digest = async (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

/** Fails closed: no RUN_KEY set means nobody starts a run. Compared as digests, so length leaks nothing. */
export async function checkRunKey(env: AppEnv, given: unknown): Promise<'ok' | 'locked' | 'wrong' | 'limited'> {
  if (!env.RUN_KEY) return 'locked';
  const now = Date.now();
  wrong = wrong.filter((t) => now - t < WINDOW_MS);
  if (wrong.length >= MAX_WRONG) return 'limited';
  const same = crypto.subtle.timingSafeEqual(await digest(env.RUN_KEY), await digest(typeof given === 'string' ? given : ''));
  if (same) return 'ok';
  wrong.push(now);
  return 'wrong';
}
