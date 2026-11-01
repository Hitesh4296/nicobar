import cases from '../../../reports/cases.json' with { type: 'json' };
import evalReport from '../../../reports/eval.json' with { type: 'json' };
import judges from '../../../reports/judges.json' with { type: 'json' };
import readiness from '../../../reports/readiness.json' with { type: 'json' };
import type { Reports } from './index.ts';

export const reports = { eval: evalReport, readiness, cases, judges } as unknown as Reports;
