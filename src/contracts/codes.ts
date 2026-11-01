// CHECK lists and check ids. test/worker/ddl.test.ts holds these equal to the migration.
import type { ConfigError } from './config.ts';

export const FAILED_CODES = ['COLD_START_NO_HISTORY', 'NO_RECOMMENDATION', 'INVALID_PICK', 'TOO_FEW_CANDIDATES',
  'INVALID_CUSTOMER', 'DUPLICATE_CUSTOMER_ID', 'CHECKS_FAILED', 'UPSTREAM_UNAVAILABLE', 'INVALID_REQUEST',
  'INTERNAL_ERROR'] as const;
export const SKIPPED_CODES = ['ESTIMATE_FAILED', 'OVER_CAP', 'RUN_CAP'] as const;
export type FailedCode = (typeof FAILED_CODES)[number];
export type SkippedCode = (typeof SKIPPED_CODES)[number];

export const CHECK_IDS = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8n', 'C8c', 'C8d', 'C8d-x', 'C8o', 'C3.L',
  'C2.L1', 'C2.L2', 'C2.L3', 'C2.L4', 'C2.L5', 'C2.L6', 'C2.L7', 'X1', 'X2', 'X3', 'X4'] as const;
export type CheckId = (typeof CHECK_IDS)[number];   // plus 'J3-*', flag only

/** Route error codes. */
export type ErrorCode = 'WRONG_STATE' | 'HASH_MISMATCH' | 'CHECKS_FAILED' | 'STALE_PICK' | 'SNAPSHOT_TOO_OLD'
  | 'PREVIEW_STALE' | 'RUN_ID_REUSED' | ConfigError | 'BAD_INPUT' | 'FORBIDDEN' | 'TOO_MANY_TRIES' | 'MISSING_CONFIG' | 'NOT_FOUND' | 'NOT_BUILT' | 'CATALOG_MISSING' | 'INTERNAL_ERROR';

export class NotBuilt extends Error {
  code = 'NOT_BUILT' as const;
}
/** The snapshot's files are not in R2: `build --publish` has not run for it. */
export class CatalogMissing extends Error {
  code = 'CATALOG_MISSING' as const;
}
export function notBuilt(what: string): never {
  throw new NotBuilt(what);
}
