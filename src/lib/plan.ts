import { notBuilt } from '../contracts/codes.ts';
import type { Catalog, IngestResult, Pinned, Plan, RecRow, RowKeys, ShapesFile } from '../contracts/types.ts';

export function planCustomer(item: IngestResult, rec: RecRow | null, keys: RowKeys, cat: Catalog, pinned: Pinned, s: ShapesFile): Plan { notBuilt('planCustomer'); }
