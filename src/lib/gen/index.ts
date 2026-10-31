import { notBuilt } from '../../contracts/codes.ts';
import type { AnthropicRequest, Catalog, CheckResult, Format, ModelDraft, ModelJson, Pinned, Plan, PromptFiles, Rung } from '../../contracts/types.ts';

export function assemblePrefix(files: PromptFiles, schemas: object[]): string { notBuilt('assemblePrefix'); }
export function renderSuffix(plan: Plan, cat: Catalog, files: PromptFiles, retry?: { failed: Format[]; checks: CheckResult[] }): string { notBuilt('renderSuffix'); }
export function buildRequest(plan: Plan, pinned: Pinned, cat: Catalog, rung: Rung, prompt: PromptFiles, retry?: { failed: Format[]; checks: CheckResult[] }): AnthropicRequest { notBuilt('buildRequest'); }
export function shapeOnly(fullSchema: object): object { notBuilt('shapeOnly'); }
export function toModelJson(text: string, parts: Format[], carried?: { part: Format; model: ModelDraft }): ModelJson { notBuilt('toModelJson'); }
