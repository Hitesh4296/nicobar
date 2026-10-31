import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Actor, AppEnv } from '../contracts/types.ts';

export type AuthResult = { actor: Actor } | { http: 403 | 503; code: 'FORBIDDEN' | 'MISSING_CONFIG' };

const jwksFor = (team: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));

/** Runs on every route; there is no public path (46 §8). `getKey` is the test seam. */
export async function authenticate(req: Request, env: AppEnv, getKey: (team: string) => JWTVerifyGetKey = jwksFor): Promise<AuthResult> {
  const { ACCESS_AUD: aud, TEAM_DOMAIN: team } = env;
  if (env.DEV_MODE === '1') {
    if (aud || team || !env.DEV_ACTOR) return { http: 503, code: 'MISSING_CONFIG' };
    return { actor: { kind: 'dev', email: env.DEV_ACTOR, sub: `dev:${env.DEV_ACTOR}` } };
  }
  if (!aud || !team) return { http: 503, code: 'MISSING_CONFIG' };
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { http: 403, code: 'FORBIDDEN' };
  try {
    const { payload } = await jwtVerify(token, getKey(team), { issuer: team, audience: aud });
    if (typeof payload.email !== 'string' || !payload.email || !payload.sub) return { http: 403, code: 'FORBIDDEN' };
    return { actor: { kind: 'human', email: payload.email, sub: payload.sub } };
  } catch {
    return { http: 403, code: 'FORBIDDEN' };
  }
}

export const sameOrigin = (req: Request): boolean => req.headers.get('Origin') === new URL(req.url).origin;
