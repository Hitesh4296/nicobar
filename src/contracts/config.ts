// Config versions.
import type { JevConfig, Stage, Weights } from './types.ts';

/** Rule switches and item ids, on top of a snapshot. Immutable once saved. */
export interface CatalogOverride { rules_off: string[]; enabled: string[]; disabled: string[] }

export type ConfigKind = 'prompt'|'jev'|'rank'|'catalog';  export type ConfigStatus = 'draft'|'active'|'retired';
export interface PromptFiles { role: string; voice_card: string; email: string; landing: string; task: string; retry: string }
export interface ConfigVersion { id: string; kind: ConfigKind; parent_id: string|null; content: PromptFiles|JevConfig|Weights|CatalogOverride; sha256: string;
  base_sha256: string; voice_guide_version: string|null; status: ConfigStatus; note: string; created_by: string; created_at: string;
  activated_by: string|null; activated_at: string|null }
export interface ConfigFailure { rule: string; file?: string; detail: string }
export type ValidationResult = { ok: true; prefix_bytes?: number } | { ok: false; failures: ConfigFailure[] };
export type ConfigError = 'UNCHANGED'|'STALE_PARENT'|'VALIDATION_FAILED'|'WRONG_STATE'|'TAMPERED'|'BASE_CHANGED'|'CONFIG_MISSING'|'NOT_FLAGGED';
export interface EvalValidity { goal: number; kind: ConfigKind; active_id: string; stages: Stage[]; run_ids: string[]; state: 'current'|'no_run_yet' }   // one per goal
export interface FlagView { question: string; flagged: boolean; dismissal: {actor_email: string; at: string; note: string}|null }

