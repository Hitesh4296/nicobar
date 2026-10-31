// Local stand-in for api.anthropic.com. $0, no key. Point ANTHROPIC_BASE_URL at it.
// Customer keyed by the first `fx-*` found in the request. fx-retry's first answer is the bad fixture; fx-refuse refuses.
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8')).drafts;
const good = load('drafts.good.json');
const bad = load('drafts.bad.json');
const part = (list: any[], p: string) => list.find((d) => p in d.draft).draft[p];

function draftFor(schema: any, list: any[]): unknown {
  const parts: string[] = schema?.required ?? [];
  if (parts.includes('email') && parts.includes('landing_page')) {
    return { email: part(list, 'email'), landing_page: part(list, 'landing_page') };
  }
  return parts.includes('sections') || schema?.properties?.sections ? part(list, 'landing_page') : part(list, 'email');
}

export function startStub(port = 0): Promise<Server> {
  const seen = new Map<string, number>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'stub' } });
    const body = JSON.parse(raw);
    const input_tokens = Math.ceil(raw.length / 4);
    if (req.url === '/v1/messages/count_tokens') return send(200, { input_tokens });
    if (req.url !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'stub' } });

    const key = /fx-[a-z]+/.exec(JSON.stringify(body.messages))?.[0] ?? 'fx-both';
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const base = { id: `msg_stub_${key}_${n}`, type: 'message', role: 'assistant', model: body.model, stop_sequence: null };
    if (key === 'fx-refuse') {
      return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
        usage: { input_tokens, output_tokens: 0 } });
    }
    const text = JSON.stringify(draftFor(body.output_config?.format?.schema, key === 'fx-retry' && n === 1 ? bad : good));
    send(200, { ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_details: null,
      usage: { input_tokens, output_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8791);
  await startStub(port);
  console.log(`stub-llm on http://127.0.0.1:${port}`);
}
