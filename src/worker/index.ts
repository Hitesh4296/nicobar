import { CatalogMissing, NotBuilt } from '../contracts/codes.ts';
import type { ErrorCode } from '../contracts/codes.ts';
import type { AppEnv } from '../contracts/types.ts';
import { authenticate, sameOrigin } from './auth.ts';
import { landing } from './routes/landing.ts';
import { checkRunKey } from './run-key.ts';
import { match } from './routes/list.ts';

export { RunWorkflow } from '../workflow/run.ts';

const fail = (http: number, code: ErrorCode, detail?: string) => Response.json({ code, detail }, { status: http });

/** R145: the public platform reads with no login; a write takes the run key, as the password of the browser's Basic prompt or as x-run-key. No credential is not a failed try. */
async function publicWriteDenied(req: Request, env: AppEnv): Promise<Response | null> {
  if (env.PUBLIC_DEMO !== '1' || req.method === 'GET' || req.method === 'HEAD') return null;
  const basic = /^Basic (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  let given = req.headers.get('x-run-key');
  try { if (basic) given = atob(basic).split(':').slice(1).join(':'); } catch { given = ''; }
  if (given !== null && await checkRunKey(env, given) === 'ok') return null;
  return new Response('Run key needed\n', { status: 401, headers: { 'www-authenticate': 'Basic realm="nicobar run key"' } });
}

export default {
  async fetch(req, env, exec) {
    if (new URL(req.url).hostname.startsWith('landing.')) return landing(req, env);
    const denied = await publicWriteDenied(req, env);
    if (denied) return denied;
    const auth = await authenticate(req, env);
    if ('http' in auth) return fail(auth.http, auth.code);
    const hit = match(req.method, new URL(req.url).pathname);
    if (!hit) return fail(404, 'NOT_FOUND');
    if (hit.route.origin && !sameOrigin(req)) return fail(403, 'FORBIDDEN');
    try {
      return await hit.route.handler({ req, env, exec, actor: auth.actor, params: hit.params });
    } catch (e) {
      if (e instanceof NotBuilt) return fail(501, 'NOT_BUILT', e.message);
      if (e instanceof CatalogMissing) return fail(503, 'CATALOG_MISSING', e.message);
      console.error(JSON.stringify({ step: 'route', path: hit.route.path, status: 'error', code: 'INTERNAL_ERROR' }));
      return fail(500, 'INTERNAL_ERROR');
    }
  },
} satisfies ExportedHandler<AppEnv>;
