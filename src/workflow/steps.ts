import { notBuilt } from '../contracts/codes.ts';
import type { AppEnv } from '../contracts/types.ts';

export async function finish(env: AppEnv, run_id: string, key: string, n: 1 | 2): Promise<{ retry: boolean }> { notBuilt('finish'); }
export async function failUnit(env: AppEnv, run_id: string, key: string, e: unknown): Promise<void> { notBuilt('failUnit'); }
