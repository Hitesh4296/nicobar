import { notBuilt } from '../../contracts/codes.ts';
import { NAV } from '../../contracts/nav.ts';
import type { Route } from './list.ts';

export const routes: Route[] = [
  // The one stub that answers: `npm run smoke` loads it. page replaces this file.
  { method: 'GET', path: '/review', handler: () => new Response(
    `<!doctype html><title>Review</title><nav>${NAV.map((n) => `<a href="${n.href}">${n.label}</a>`).join(' ')}</nav>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  { method: 'GET', path: '/review/runs/:id/plans', handler: () => notBuilt('review plans') },
  { method: 'GET', path: '/review/:id', handler: () => notBuilt('review draft') },
  { method: 'POST', path: '/api/drafts/:id/:action(approve|reject|revoke|release)', origin: true, handler: () => notBuilt('draft action') },
  { method: 'GET', path: '/released/:id', handler: () => notBuilt('released') },
];
