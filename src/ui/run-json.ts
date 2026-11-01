// One run as one JSON document. Stored rows only: a value nobody stored is null. Plans hold no note and no last name; the raw model answer and unit error text stay out.
import type { JevIn, CustomerData, RunIn } from './timeline.ts';
import { checksOf, generatedBy } from './evidence.ts';
import { failed } from './checks.ts';

const add = (xs: { charged_usd: number | null }[]) => (xs.some((x) => x.charged_usd !== null) ? xs.reduce((t, x) => t + (x.charged_usd ?? 0), 0) : null);

function customer(c: CustomerData, run: RunIn) {
  const p = c.plan, last = c.drafts.at(-1);
  return { customer_id: c.unit.customer_id, display_name: p?.display_name ?? null, occasion: p?.occasion ?? null,
    input: p ? { occasion: p.occasion, occasion_key: p.occasion_key, shape: p.shape, new_user: p.new_user, format: p.format } : null,
    filter_counts: p?.pool ?? null,
    picks: (p?.picks ?? []).map((k) => ({ slot: k.slot, product_id: k.product_id, reason_code: k.reason_code, score: k.score ?? null, why: k.why ?? null })),
    sections: (p?.more ?? []).map((m) => ({ kind: m.kind, heading: m.heading, product_ids: m.product_ids })),
    generated_by: generatedBy(c, run),
    attempts: c.drafts.map((d) => ({ attempt: d.version, draft_id: d.id, status: d.status, hard_failures: d.hard_failures, failed_checks: failed(checksOf(d)).map(({ id, part, code, field }) => ({ id, part, code: code ?? null, field: field ?? null })), generated_by: generatedBy(c, run, d) })),
    costs: { est_usd: c.costs.find((x) => x.attempt === 1)?.est_usd ?? null, charged_usd: add(c.costs), jev_usd: add(c.jev as JevIn[]) },
    final_status: { unit: c.unit.status, code: c.unit.code, draft: last?.status ?? null } };
}

export function runJson(run: RunIn, customers: CustomerData[]) {
  const ranking = customers.find((c) => c.plan?.generated_by)?.plan?.generated_by?.ranking ?? null;
  const has = (k: 'email' | 'landing' | 'catalog') => customers.filter((c) => { const d = c.drafts.at(-1); return typeof d?.[k] === 'string'; }).length;
  return { run: { id: run.id, stage: run.stage ?? null, status: run.status, spent: run.spent_usd ?? null, cap: run.cap_run_usd ?? null, ranking_version: ranking?.version ?? null, weights: ranking?.weights ?? null,
    prompt_version: run.prompt_version ?? null, snapshot_id: run.snapshot_id ?? null, rendered_totals: { customers: customers.length, email: has('email'), landing_page: has('landing'), catalog: has('catalog') } },
    customers: customers.map((c) => customer(c, run)) };
}
