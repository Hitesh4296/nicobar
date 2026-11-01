// Ranking inside the Worker: the Refine page's preview, and Start a run at the active version. The row rules are bundled; customers and catalog come from R2.
import ranking from '../../../config/ranking.json' with { type: 'json' };
import hand from '../../../data/hand_table.synthetic.json' with { type: 'json' };
import rowKeys from '../../../data/row_keys.synthetic.json' with { type: 'json' };
import type { Catalog, ConfigVersion, RecFile, RowKeys, Weights } from '../../contracts/types.ts';
import { RANK_RULE, rankAll, rankConfig, rankingBy, readCustomers, type RankConfig } from './index.ts';

export const BASE_WEIGHTS = ranking.weights as Weights;

export const liveConfig = (version: string, weights: Weights): RankConfig =>
  ({ ...rankConfig(ranking, rowKeys as RowKeys, hand.rows as unknown as Record<string, { picks: string[] }>), version, weights });

/** The recommendations file at this version. Same inputs, same bytes: the preview at Start a run hashes it and POST checks that hash. */
export function rankedRecs(base: RecFile, tsv: string, cat: Pick<Catalog, 'usable'>, v: Pick<ConfigVersion, 'id'|'content'>): string {
  const cfg = liveConfig(v.id, v.content as Weights);
  const file: RecFile = { ...base, rule: RANK_RULE, rows: rankAll(readCustomers(tsv), cat, cfg), generated_by: rankingBy(cfg, base.snapshot_id) };
  return JSON.stringify(file);
}
