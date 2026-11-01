import emailSchema from '../../../config/schemas/draft-email.v2.json' with { type: 'json' };
import landingSchema from '../../../config/schemas/draft-landing.v3.json' with { type: 'json' };
import bothSchema from '../../../config/schemas/draft-both.v1.json' with { type: 'json' };
import quotesFile from '../../../config/quotes.json' with { type: 'json' };
import occasionMap from '../../../config/occasion_map.json' with { type: 'json' };
import type { AnthropicRequest, Catalog, CheckResult, Format, ModelDraft, ModelJson, Pinned, Plan, Product, PromptFiles, Rung, RunFormat } from '../../contracts/types.ts';
import { lf } from './canonical.ts';

type Retry = { failed: Format[]; checks: CheckResult[] };

/** The prefix's schemas, in README order. `loadVersion`'s bundle is this array. */
export const PROMPT_SCHEMAS: object[] = [emailSchema, landingSchema];
const REQUEST_SCHEMA: Record<RunFormat, object> = { both: bothSchema, email: emailSchema, landing_page: landingSchema };
const REFS: Record<string, Record<string, any>> = { [emailSchema.$id]: emailSchema, [landingSchema.$id]: landingSchema };

export const schemaId = (f: RunFormat): string => (REQUEST_SCHEMA[f] as { $id: string }).$id;
export const partsOf = (f: RunFormat): Format[] => (f === 'both' ? ['email', 'landing_page'] : [f]);
const formatOf = (parts: Format[]): RunFormat => (parts.length === 1 ? parts[0] : 'both');

const part = (s: string) => lf(s).trimEnd();

export function assemblePrefix(files: PromptFiles, schemas: object[]): string {
  return [files.role, files.voice_card, files.email, files.landing].map(part)
    .concat('# Output schemas', schemas.map((s) => JSON.stringify(s))).join('\n\n');
}

/** Parts attempt 2 rewrites. A C1 failure, which a `max_tokens` stop always is, leaves nothing to carry. `finish` carries the rest. */
export function retryParts(format: RunFormat, retry: Retry): Format[] {
  const all = partsOf(format);
  return retry.checks.some((c) => c.id === 'C1' && !c.pass) ? all : all.filter((p) => retry.failed.includes(p));
}

const product = (cat: Catalog, id: string): Product => {
  const p = cat.rows.get(id);
  if (!p) throw new Error(`pick not in catalogue: ${id}`);
  return p;
};
// The prose word counter: whitespace chunks holding a letter or digit.
const words = (titles: string[]) => titles.join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function eligibleQuotes(plan: Plan): { id: string; text: string }[] {
  const key = plan.occasion_key;
  if (key === null) return [];
  const labels = occasionMap.quote_labels as Record<string, string[]>;
  return quotesFile.quotes
    .filter((q) => q.labels.some((l) => labels[l]?.includes(key)) && (q.id !== 'E6' || plan.picks.some((p) => p.group === 'home')))
    .map(({ id, text }) => ({ id, text }));
}

export function renderSuffix(plan: Plan, cat: Catalog, files: PromptFiles, retry?: Retry): string {
  const parts = retry ? retryParts(plan.format, retry) : partsOf(plan.format);
  const titles = plan.picks.map((p) => product(cat, p.product_id).title);
  const values: Record<string, string> = {
    parts: parts.join(' and '),
    n: String(plan.picks.length),
    occasion_key: plan.occasion_key ?? 'null',
    shape: plan.shape ?? 'open',
    title_words: String(words(titles)),
    title_words_email: String(words(titles.slice(0, 3))),
    occasion: (plan.occasion ?? '').replace(/[<>]/g, '').trim() || 'none',
    picks: JSON.stringify(plan.picks.map((p, i) => ({ slot: p.slot, group: p.group, title: titles[i], body: product(cat, p.product_id).body_text_clean ?? '' }))),
    quotes: JSON.stringify(eligibleQuotes(plan)),
  };
  if (retry) {
    values.checks = retry.checks.filter((c) => !c.pass && c.severity === 'hard' && parts.includes(c.part as Format))
      .map((c) => `${c.part}.${c.id}: ${c.detail ?? c.code ?? ''}`).join('\n');
  }
  const template = retry ? `${part(files.task)}\n\n${part(files.retry)}` : part(files.task);
  // One pass: a `{{` inside the occasion is data, never a placeholder.
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`unknown placeholder: ${name}`);
    return v;
  });
}

export function buildRequest(plan: Plan, _pinned: Pinned, cat: Catalog, rung: Rung, prompt: PromptFiles, retry?: Retry): AnthropicRequest {
  const format = retry ? formatOf(retryParts(plan.format, retry)) : plan.format;
  return {
    model: rung.model,
    max_tokens: rung.max_tokens[format],
    system: [{ type: 'text', text: assemblePrefix(prompt, PROMPT_SCHEMAS), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: renderSuffix(plan, cat, prompt, retry) }],
    ...(rung.thinking ? { thinking: rung.thinking } : {}),
    output_config: { ...(rung.effort ? { effort: rung.effort } : {}), format: { type: 'json_schema', schema: shapeOnly(REQUEST_SCHEMA[format]) } },
  };
}

const DROP = new Set(['$id', '$schema', '$defs', 'title', 'description', 'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'pattern']);
const SLOT_PATTERN = '^p[1-6]$';

function shape(n: any, root: any): any {
  if (Array.isArray(n)) return n.map((x) => shape(x, root));
  if (!n || typeof n !== 'object') return n;
  if (typeof n.$ref === 'string') {
    const local = /^#\/\$defs\/(.+)$/.exec(n.$ref)?.[1];
    const target = local ? root.$defs?.[local] : REFS[n.$ref];
    if (!target) throw new Error(`unknown $ref: ${n.$ref}`);
    return shape(target, local ? root : target);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (DROP.has(k) || k === 'required' || k === 'additionalProperties') continue;
    if (k === 'minItems' && (v as number) > 1) continue;
    // `properties` maps names to schemas: a field may be called `title`.
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, shape(s, root)]));
    else out[k === 'oneOf' ? 'anyOf' : k] = shape(v, root);
  }
  if (n.pattern === SLOT_PATTERN) out.enum = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  if (n.type === 'object') {
    out.required = Object.keys(n.properties ?? {});
    out.additionalProperties = false;
  }
  return out;
}

/** The request schema: what the API accepts. The full schema stays as C1. */
export function shapeOnly(fullSchema: object): object {
  return shape(fullSchema, fullSchema);
}

export function toModelJson(text: string, parts: Format[], carried?: { part: Format; model: ModelDraft }): ModelJson {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const isObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  const fresh: ModelJson = !isObject ? { unparsed: text }
    : parts.length === 1 ? { [parts[0]]: parsed as ModelDraft } : parsed as ModelJson;
  if (!carried) return fresh;
  // Email first either way, so the stored JSON has one key order.
  return carried.part === 'email' ? { email: carried.model, ...fresh } : { ...fresh, landing_page: carried.model };
}
