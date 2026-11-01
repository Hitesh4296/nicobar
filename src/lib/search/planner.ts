// The request for one customer's queries (R141). What goes in is listed here and nowhere else: no name, no id, no note beyond its noun.
import type { Vocabulary } from './vocabulary.ts';

export interface PlannerInput { occasion: string|null; past_item: string|null; new_user: boolean }
// The API refuses a schema this enum makes too big: 327 values compiled, 365 did not [verified 2026-11-01]. Long families keep their larger values. The search page and code gates still hold every value.
const MIN_COUNT: Record<string, number> = { colour: 60, campaign: 60, collection: 60, subclass: 10, material: 10 }, MIN_VALUE_COUNT = 3;
const shown = (f: string, vals: Vocabulary[string]) => vals.filter((x) => x.count >= (MIN_COUNT[f] ?? MIN_VALUE_COUNT));
const MAX_TOKENS = 4000;

/** family=value, for the values worth offering. The schema's enum is this list. */
export const offered = (v: Vocabulary) => Object.entries(v).flatMap(([f, vals]) => shown(f, vals).map((x) => `${f}=${x.value}`));

export function plannerSchema(v: Vocabulary): object {
  const filter = { $ref: '#/$defs/filter' };
  const query = (extra: object, need: string[]) => ({ type: 'object', additionalProperties: false, required: ['purpose', 'filters', 'exclude', ...need], properties: { purpose: { type: 'string' }, filters: { type: 'array', items: filter }, exclude: { type: 'array', items: filter }, ...extra } });
  return { type: 'object', additionalProperties: false, required: ['primary', 'sections'], $defs: { filter: { type: 'string', enum: offered(v) } }, properties: { primary: query({}, []), sections: { type: 'array', items: query({ from_past: { type: 'boolean' } }, ['from_past']) } } };
}

export const vocabularyText = (v: Vocabulary) => Object.entries(v).map(([f, vals]) => `${f}: ${shown(f, vals).map((x) => `${x.value} (${x.count})`).join(', ')}`).join('\n');

export function plannerRequest(input: PlannerInput, v: Vocabulary, prompt: string, model: string) {
  const user = `<occasion>${(input.occasion ?? 'none').replace(/[<>]/g, '')}</occasion>\n<past_item>${input.past_item ?? 'none'}</past_item>\n<new_customer>${input.new_user}</new_customer>`;
  return { model, max_tokens: MAX_TOKENS, system: [{ type: 'text' as const, text: `${prompt}\n\n# Vocabulary, value (products)\n${vocabularyText(v)}`, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: user }], output_config: { effort: 'low' as const, format: { type: 'json_schema' as const, schema: plannerSchema(v) } } };
}

/** `family=value` strings back to filters. A value may hold `=`. */
export function toFilters(list: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of list) { const i = s.indexOf('='); (out[s.slice(0, i)] ??= []).push(s.slice(i + 1)); }
  return out;
}
