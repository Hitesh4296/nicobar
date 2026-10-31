# Check lists: how the per-row files are read

All matching runs on raw model text, after the apostrophe fold, on every string field. None runs on expanded or rendered text, so a pick's title renders verbatim.

| file | shape | check | rule |
|---|---|---|---|
| `lists/c8n.json` | `{customer_id: string[]}` | C8n, hard | case-insensitive, `\b<span>\b`, whitespace runs folded. Also fires on the head noun, the last word of the row's last span, with a past-time cue in the same sentence (`PAST_CUE` in `src/lib/check/index.ts`). A row or id with no entry, or `[]`, passes |
| `lists/c8_allow.json` `per_row` | `{customer_id: string[]}`, lower case | C8c, C8d, C8d-x | a capitalised token is allowed if, lower-cased, it is in the row's list or in `c8o.json`. A missing id has no row tokens |
| `lists/c8o.json` `names` | `string[]` | C8o, hard | case-insensitive, `\b<name>\b`. Runs only when `plan.occasion` is null |
| `lists/c4.json` group `familiarity` | patterns | C4, hard | as every C4 pattern. No bare `again` |

**`c8n.json`** holds two-word spans of the item in each row's purchase note, and nothing of the use or date. Nothing in the prompt carries the note, so this is a net, not the main defence. `block-print scarf` keeps the whole phrase in both spellings, because `block print` alone appears in 22 product bodies and would reject true copy on a real pick. The file is short spans of real customer notes and ships in the Worker, because C8n runs again at approval.

**`per_row`** is each occasion's words, without `in`, `to`, `at`. It exists so a place or festival repeated from the occasion does not read as a made-up name.

**`c8o.json`** comes from the occasion file, `occasion_map` keys and common Indian festivals `[assume]`. It leaves out words of ordinary use: dinner, lunch, trip, weekend, evening, home, gift. `festive` is the costly name: 57 of 361 available festive-tagged home rows say it in their body `[verified 2026-11-01, snapshot of 2026-10-29]`, so an echo fails and retries.
