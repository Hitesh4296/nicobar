import evalReport from '../../../reports/eval.json' with { type: 'json' };
import readiness from '../../../reports/readiness.json' with { type: 'json' };

export const reports: { eval: unknown; readiness: unknown } = { eval: evalReport, readiness };
