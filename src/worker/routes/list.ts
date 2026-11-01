import type { Actor, AppEnv } from '../../contracts/types.ts';
import { routes as agents } from './agents.ts';
import { routes as catalog } from './catalog.ts';
import { routes as demo } from './demo.ts';
import { routes as review } from './review.ts';
import { routes as runs } from './runs.ts';
import { routes as start } from './start.ts';

export interface Ctx { req: Request; env: AppEnv; exec: ExecutionContext; actor: Actor; params: Record<string, string> }
export interface Route { method: 'GET' | 'POST'; path: string; origin?: true; handler(c: Ctx): Response | Promise<Response> }

// First match wins. demo, catalog and agents stay before review, so /review/spend never reaches /review/:id.
export const ROUTES: Route[] = [...demo, ...catalog, ...agents, ...start, ...review, ...runs];

export function match(method: string, pathname: string, table: Route[] = ROUTES) {
  for (const route of table) {
    if (route.method !== method) continue;
    const m = new URLPattern({ pathname: route.path }).exec({ pathname });
    if (m) return { route, params: m.pathname.groups as Record<string, string> };
  }
  return null;
}
