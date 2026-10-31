import { notBuilt } from '../../contracts/codes.ts';
import type { Route } from './list.ts';

export const routes: Route[] = [
  { method: 'GET', path: '/review/agents', handler: () => notBuilt('agents list') },
  { method: 'GET', path: '/review/agents/:id', handler: () => notBuilt('agents version') },
  { method: 'GET', path: '/api/config/:id', handler: () => notBuilt('config read') },
  { method: 'POST', path: '/api/config', origin: true, handler: () => notBuilt('config save') },
  { method: 'POST', path: '/api/config/:id/activate', origin: true, handler: () => notBuilt('config activate') },
  { method: 'POST', path: '/api/config/:id/judge', origin: true, handler: () => notBuilt('config judge') },
  { method: 'POST', path: '/api/drafts/:id/flags/:question/dismiss', origin: true, handler: () => notBuilt('flag dismiss') },
];
