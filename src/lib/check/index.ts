import { notBuilt } from '../../contracts/codes.ts';
import type { Catalog, CheckResult, Envelope, Plan } from '../../contracts/types.ts';

export function validate(model_json: string, envelope: Envelope, cat: Catalog, plan: Plan): CheckResult[] { notBuilt('validate'); }
