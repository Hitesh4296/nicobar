import { renderEvals, renderPublished, renderSpend } from '../../ui/demo/index.ts';
import type { PublishedRow, SpendRow } from '../../ui/demo/index.ts';
import { reports } from '../../ui/demo/reports.ts';
import type { Ctx, Route } from './list.ts';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

async function spend({ env }: Ctx): Promise<Response> {
  const runs = await env.DB.prepare(`SELECT r.id, r.stage, r.status, r.expected_usd, r.spent_usd, r.cap_run_usd, r.ceiling_usd, r.created_at,
      (SELECT COALESCE(SUM(j.charged_usd), 0) FROM jev_events j WHERE j.run_id = r.id) AS jev_usd,
      (SELECT GROUP_CONCAT(a, ', ') FROM (SELECT action || ' ' || COUNT(*) AS a FROM cost_events c WHERE c.run_id = r.id GROUP BY action)) AS actions
    FROM runs r ORDER BY r.created_at DESC`).all<SpendRow>();
  const ledger = await env.DB.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ledger_manual').first<{ usd: number }>();
  return html(renderSpend(runs.results, ledger?.usd ?? 0));
}

async function published({ env }: Ctx): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT d.id, d.customer_id, d.format, json_extract(p.plan_json, '$.display_name') AS display_name,
      d.approved_by, d.approved_at, d.released_by, d.released_at, d.content_sha256
    FROM drafts d LEFT JOIN plans p ON p.run_id = d.run_id AND p.customer_id = d.customer_id
    WHERE d.status = 'released' ORDER BY d.released_at DESC`).all<PublishedRow>();
  return html(renderPublished(rows.results));
}

export const routes: Route[] = [
  { method: 'GET', path: '/review/spend', handler: spend },
  { method: 'GET', path: '/review/published', handler: published },
  { method: 'GET', path: '/review/evals', handler: () => html(renderEvals(reports)) },
];
