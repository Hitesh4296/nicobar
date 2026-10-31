import { renderEvals, renderPublished, renderSpend } from '../../ui/demo/index.ts';
import type { Route } from './list.ts';

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

export const routes: Route[] = [
  { method: 'GET', path: '/review/spend', handler: () => html(renderSpend()) },
  { method: 'GET', path: '/review/published', handler: () => html(renderPublished()) },
  { method: 'GET', path: '/review/evals', handler: () => html(renderEvals()) },
];
