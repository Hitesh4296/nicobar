// R143: the public host. GET only, three paths, released parts of the published run. No auth, no write, no other route.
// Anything that cannot be served is one 404, so a guess learns nothing about state. Customer ids are guessable: fit for labelled synthetic data only.
import type { AppEnv, RenderedJson } from '../../contracts/types.ts';
import { landingLink } from '../../lib/render/email.ts';
import { CSP } from './review.ts';

const PATH = /^\/([A-Za-z0-9_-]{1,64})(?:\/(email|catalog))?$/;
const BASE = { 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };   // no-store: a revoke bites on the next load
const LABEL = '<p style="margin:0;padding:8px 16px;background:#fff;color:#333;font:400 13px/18px sans-serif;text-align:center">A demo with synthetic customers. Nothing here was sent.</p>';

const text = (body: string, status: number) => new Response(body, { status, headers: { ...BASE, 'content-type': 'text/plain; charset=utf-8' } });
const notFound = () => text('Not found\n', 404);
const contentSha256 = async (e: string, m: string, r: string) => (await import('../../contracts/lib.ts')).contentSha256(e, m, r);

/** The newest real run with anything released. One customer's page never comes from an older run, and a stub never publishes. */
const RELEASED = `SELECT envelope_json, model_json, rendered_json, approved_sha256 FROM drafts
  WHERE customer_id = ?1 AND status = 'released' AND run_id = (SELECT r.id FROM runs r WHERE r.id NOT LIKE 'stub-%'
    AND EXISTS (SELECT 1 FROM drafts d WHERE d.run_id = r.id AND d.status = 'released') ORDER BY r.created_at DESC, r.id LIMIT 1)
  ORDER BY version DESC LIMIT 1`;

interface Row { envelope_json: string; model_json: string; rendered_json: string; approved_sha256: string }

export async function landing(req: Request, env: AppEnv): Promise<Response> {
  const { pathname, origin } = new URL(req.url);
  if (req.method !== 'GET') return notFound();
  if (pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n', 200);
  const m = PATH.exec(pathname);
  if (!m) return notFound();
  const [, customer, sub] = m;
  try {
    const row = await env.DB.prepare(RELEASED).bind(customer).first<Row>();
    if (!row || await contentSha256(row.envelope_json, row.model_json, row.rendered_json) !== row.approved_sha256) return notFound();
    const part = sub === 'email' ? 'email' : sub === 'catalog' ? 'catalog' : 'landing_page';
    const body = (JSON.parse(row.rendered_json) as RenderedJson)[part];
    if (!body) return notFound();
    const page = part === 'email' ? landingLink(body, `${env.PUBLIC_ORIGIN || origin}/${customer}`) : body;   // after the hash: the stored email stays as approved
    return new Response(page.replace(/<body[^>]*>/, (tag) => tag + LABEL), { headers: { ...BASE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `sandbox; ${CSP}` } });
  } catch {
    console.error(JSON.stringify({ step: 'landing', status: 'error', code: 'INTERNAL_ERROR' }));
    return text('Unavailable\n', 503);
  }
}
