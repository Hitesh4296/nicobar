import { CatalogMissing, NotBuilt } from '../contracts/codes.ts';
import type { ErrorCode } from '../contracts/codes.ts';
import type { AppEnv } from '../contracts/types.ts';
import { authenticate, sameOrigin } from './auth.ts';
import { match } from './routes/list.ts';

export { RunWorkflow } from '../workflow/run.ts';

const fail = (http: number, code: ErrorCode, detail?: string) => Response.json({ code, detail }, { status: http });

export default {
  async fetch(req, env, exec) {
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
