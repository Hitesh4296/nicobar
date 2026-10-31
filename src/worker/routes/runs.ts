import { notBuilt } from '../../contracts/codes.ts';
import type { Route } from './list.ts';

export const routes: Route[] = [
  { method: 'POST', path: '/api/runs', handler: () => notBuilt('runs create') },
  { method: 'POST', path: '/api/runs/:id/restart', handler: () => notBuilt('runs restart') },
  { method: 'POST', path: '/api/runs/:id/mark-stopped', handler: () => notBuilt('runs mark-stopped') },
  { method: 'POST', path: '/api/ledger', handler: () => notBuilt('ledger') },
];
