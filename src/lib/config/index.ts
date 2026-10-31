import { notBuilt } from '../../contracts/codes.ts';
import type { Actor, AppEnv, Catalog, ConfigKind, ConfigVersion, EvalValidity, FlagView, JevConfig, Plan, PromptFiles,
  ValidationResult } from '../../contracts/types.ts';

export async function activeVersions(db: D1Database): Promise<{ prompt: ConfigVersion; jev: ConfigVersion }> { notBuilt('activeVersions'); }
export async function loadVersion(db: D1Database, id: string, bundle: { schemas: object[]; jevBase: JevConfig }): Promise<ConfigVersion> { notBuilt('loadVersion'); }
export function validatePrompt(files: PromptFiles, schemas: object[], fixture: Plan, cat: Catalog): ValidationResult { notBuilt('validatePrompt'); }
export function validateJev(next: JevConfig, base: JevConfig): ValidationResult { notBuilt('validateJev'); }
export async function saveVersion(db: D1Database, kind: ConfigKind, parent_id: string | null, content: PromptFiles | JevConfig, note: string, actor: Actor): Promise<ConfigVersion> { notBuilt('saveVersion'); }
export async function activateVersion(db: D1Database, id: string, actor: Actor): Promise<ConfigVersion> { notBuilt('activateVersion'); }
export function lineDiff(a: string, b: string): { op: '=' | '+' | '-'; text: string }[] { notBuilt('lineDiff'); }
export async function dismissFlag(env: AppEnv, draft_id: string, question: string, note: string, actor: Actor): Promise<void> { notBuilt('dismissFlag'); }
export async function reviewFlags(env: AppEnv, draft_id: string): Promise<FlagView[]> { notBuilt('reviewFlags'); }
export async function evalValidity(db: D1Database): Promise<EvalValidity[]> { notBuilt('evalValidity'); }
