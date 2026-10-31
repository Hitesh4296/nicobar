import type { JevConfig, PromptFiles } from '../../contracts/types.ts';

export const lf = (s: string): string => s.replace(/\r\n?/g, '\n');

const norm = (v: unknown): unknown => {
  if (typeof v === 'string') return lf(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  }
  return v;
};

/** The only serialiser hashed: LF only, keys sorted at every depth. */
export function canonicalContent(c: PromptFiles | JevConfig): string {
  return JSON.stringify(norm(c));
}
