import { notBuilt } from '../../contracts/codes.ts';
import type { AppEnv, Catalog, DraftRow, J3Input, JevConfig, JevOutcome, Plan } from '../../contracts/types.ts';

export function j3Input(d: DraftRow, plan: Plan, cat: Catalog): J3Input { notBuilt('j3Input'); }
export async function judgeDraft(env: AppEnv, input: J3Input, cfg: JevConfig): Promise<JevOutcome> { notBuilt('judgeDraft'); }
export function flaggedQuestions(answers: Record<string, unknown>, cfg: JevConfig): string[] { notBuilt('flaggedQuestions'); }
export async function jevPreflight(env: AppEnv, cfg: JevConfig): Promise<{ ok: true } | { ok: false; reason: string }> { notBuilt('jevPreflight'); }
export async function jevReserveOk(db: D1Database, basis_usd: number): Promise<boolean> { notBuilt('jevReserveOk'); }
