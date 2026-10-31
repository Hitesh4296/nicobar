// Local stand-in for api.anthropic.com. $0, no key. Point ANTHROPIC_BASE_URL at it.
// A real request (it holds `<picks>`) is answered per plan: a draft that fills its slots, shape and occasion, built here and judged by the real validator.
// The last word of the occasion is a marker for scripted failure: x429, xrefuse, xbad, xbadboth, xfail. Readiness writes them; any other word is only a label.
// A request with no `<picks>` is a fixture: keyed by the first `fx-*`. fx-retry's first answer is the bad fixture; fx-refuse refuses.
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

interface Req { occasion: string; key: string; occasion_key: string | null; shape: string; picks: { slot: string; group: string }[] }
const DISCOUNT = ' Now 20% off.';

function readPlan(user: string): Req | null {
  const picks = /<picks>\n(.*?)\n<\/picks>/s.exec(user)?.[1];
  if (!picks) return null;
  const raw = /<occasion>(.*?)<\/occasion>/s.exec(user)?.[1] ?? 'none';
  const key = /^(?:d\d\d|x\w+|ok1|big)$/.test(raw.split(' ').at(-1)!) ? raw.split(' ').at(-1)! : raw.split(' ').at(-1)!.toLowerCase();
  const occasion = raw.replace(/\s*\b(?:d\d\d|x\w+|ok1|big)$/, '').split(' ').slice(0, 5).join(' ').replace(/[^\p{L}' ]/gu, '').trim();
  const k = /^Occasion key: (.*)$/m.exec(user)?.[1] ?? 'null';
  return { occasion, key, occasion_key: k === 'null' ? null : k, shape: /^Shape: (.*)$/m.exec(user)?.[1] ?? 'open', picks: JSON.parse(picks) };
}

const CAPTION = 'Kept close, for the day ahead.';
const fill = (rest: string[]) => {
  const grid = rest.slice(0, 4);
  const feature = (slot: string) => ({ type: 'feature', slot, line: 'Set apart from the others, for the part of the day that asks a little more of you.' });
  return [...(grid.length === 1 ? [feature(grid[0]!)] : [{ type: 'product_grid', items: grid.map((slot) => ({ slot, caption: CAPTION })) }]), ...rest.slice(4).map(feature)];
};

/** Valid for any plan of 4 to 6 picks. Generic on purpose: no material, colour or count, so the grounding checks have nothing to refuse. Voice is not what this proves. */
function landing(r: Req) {
  const slots = r.picks.map((p) => p.slot);
  const heading = r.occasion && r.occasion !== 'none' ? `For ${r.occasion}` : 'For an ordinary morning';
  const hero = (slot: string) => ({ type: 'hero', slot, heading, line: 'Chosen for the way the day will go, and easy to carry from morning to night.' });
  const story = { type: 'story', text: 'A few things, in the order the day asks for them, from the first hour to the last, with nothing here to plan around.' };
  let sections: unknown[];
  if (r.shape === 'trip') sections = [hero(slots[0]!), { type: 'packing_list', items: slots.slice(1).map((slot) => ({ slot, note: 'Goes in the bag early' })) }, story];
  else if (r.shape === 'gift') sections = [hero(slots[0]!), story, { type: 'feature', slot: slots[1], line: 'Kept for later in the day, when there is time to open something slowly and look at it.' }, ...fill(slots.slice(2))];
  else if (r.shape === 'wedding') {
    const a = r.picks.find((p) => r.picks.filter((q) => q.group === p.group).length > 1)!;
    const pair = r.picks.filter((p) => p.group === a.group).slice(0, 2).map((p) => p.slot);
    const rest = slots.filter((s) => !pair.includes(s));
    sections = [hero(rest[0]!), { type: 'pairing', slots: pair, line: 'One for the first hour, and one for the hour the day turns into a long evening.' }, story, ...(rest.length > 1 ? fill(rest.slice(1)) : [])];
  } else sections = [hero(slots[0]!), story, ...fill(slots.slice(1))];
  return { occasion_key: r.occasion_key, sections };
}

function email(r: Req) {
  const who = r.occasion && r.occasion !== 'none' ? r.occasion : 'An ordinary week';
  return { occasion_key: r.occasion_key, subject: 'A few things for the day', preheader: 'Chosen for the way the day will go, from morning to night.',
    body: `${who}, and a few things worth keeping close.\n\n{p1} comes first, for the start of the day, when the house is still quiet.\n\n{p2} is for the long middle of it, when you are out and moving between rooms.\n\n{p3} is for the end, when the day has gone the way it went.` };
}

function perPlan(r: Req, parts: string[], n: number) {
  const d: Record<string, any> = { email: email(r), landing_page: landing(r) };
  const m = r.key;
  if (m === 'xfail' || (m === 'xbad' && n === 1) || (m === 'xbadboth' && n === 1)) d.landing_page.sections[0].line += DISCOUNT;
  if (m === 'xfail' || (m === 'xbadboth' && n === 1)) d.email.body += DISCOUNT;
  return parts.length === 2 ? d : d[parts[0]!];
}

export interface Call { key: string; parts: string; n: number; status: number }
export interface StubOptions {
  calls?: Call[];                                  // appended to, one row per /v1/messages call
  onAnswer?: (key: string, answered: number) => void;   // before the answer goes out, so a kill can land between the answer and the worker's write
  delayMs?: number;                                // holds calls open, so a kill finds some in flight
  count?: (input_tokens: number) => number;        // what count_tokens reports; readiness lies through this to prove the cap reads it
}

export function startStub(port = 0, o: StubOptions = {}): Promise<Server> {
  const calls = o.calls ?? [];
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
    if (req.url === '/v1/messages/count_tokens') return send(200, { input_tokens: o.count ? o.count(input_tokens) : input_tokens });
    if (req.url !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'stub' } });

    const user = String(body.messages?.[0]?.content ?? '');
    const plan = typeof body.messages?.[0]?.content === 'string' ? readPlan(user) : null;
    const key = plan?.key ?? /fx-[a-z]+/.exec(JSON.stringify(body.messages))?.[0] ?? 'fx-both';
    const n = calls.filter((c) => c.key === key).length + 1;   // a caller that empties `calls` starts every marker over
    const base = { id: `msg_stub_${key}_${n}`, type: 'message', role: 'assistant', model: body.model, stop_sequence: null };
    const schema = body.output_config?.format?.schema;
    const parts: string[] = schema?.required?.includes('email') ? ['email', 'landing_page'] : schema?.properties?.sections ? ['landing_page'] : ['email'];
    const log = (status: number) => calls.push({ key, parts: parts.join('+'), n, status });
    if (key === 'x429' && n === 1) { log(429); return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'stub' } }); }
    log(200);
    if (key === 'fx-refuse' || key === 'xrefuse') {
      return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
        usage: { input_tokens, output_tokens: 0 } });
    }
    if (o.delayMs) await new Promise((ok) => setTimeout(ok, o.delayMs));
    const text = JSON.stringify(plan ? perPlan(plan, parts, n) : draftFor(schema, key === 'fx-retry' && n === 1 ? bad : good));
    o.onAnswer?.(key, calls.filter((c) => c.status === 200).length);
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
