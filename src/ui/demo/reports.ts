// ponytail: part 2 swaps these for build-time imports of reports/eval.json and reports/readiness.json, once `check` and `proof` have merged them;
// importing a file that does not exist yet breaks the build.
export const reports: { eval: unknown; readiness: unknown } = { eval: null, readiness: null };
