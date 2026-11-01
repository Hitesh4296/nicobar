// Ranking inside the Worker: the Refine page's preview, and Start a run at the active version. The row rules are bundled; customers and catalog come from R2.
import ranking from '../../../config/ranking.json' with { type: 'json' };
import hand from '../../../data/hand_table.synthetic.json' with { type: 'json' };
import queries from '../../../data/queries.synthetic.json' with { type: 'json' };
import rowKeys from '../../../data/row_keys.synthetic.json' with { type: 'json' };
import type { Catalog, CatalogOverride, ConfigVersion, RecFile, RowKeys, Weights } from '../../contracts/types.ts';
import { applyCatalog, rankConfigFor } from '../catalog/override.ts';
import type { QueriesFile } from '../search/gate.ts';
import { RANK_RULE, rankAll, rankConfig, rankingBy, readCustomers, type RankConfig } from './index.ts';

export const BASE_WEIGHTS = ranking.weights as Weights;

export const liveConfig = (version: string, weights: Weights): RankConfig =>
  ({ ...rankConfig(ranking, rowKeys as RowKeys, hand.rows as unknown as Record<string, { picks: string[] }>, queries as unknown as QueriesFile), version, weights });

/** The recommendations file at this version. Same inputs, same bytes: the preview at Start a run hashes it and POST checks that hash. */
export function rankedRecs(base: RecFile, tsv: string, cat: Catalog, v: Pick<ConfigVersion, 'id'|'content'>, catalog: Pick<ConfigVersion, 'id'|'content'>|null = null): string {
  const live = overridden(cat, liveConfig(v.id, v.content as Weights), catalog);
  const file: RecFile = { ...base, rule: RANK_RULE, rows: rankAll(readCustomers(tsv), live.cat, live.cfg), generated_by: rankingBy(live.cfg, base.snapshot_id, catalog?.id) };
  return JSON.stringify(file);
}

/** The catalog and config a ranking reads at this version. No version: the snapshot as it stands. */
export function overridden(cat: Catalog, cfg: RankConfig, catalog: Pick<ConfigVersion, 'content'>|null): { cat: Catalog; cfg: RankConfig } {
  if (!catalog) return { cat, cfg };
  const applied = applyCatalog(cat, catalog.content as CatalogOverride);
  return { cat: applied, cfg: rankConfigFor(cfg, applied) };
}
