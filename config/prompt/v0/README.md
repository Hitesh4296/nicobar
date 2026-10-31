# Prompt v0

A version is never edited in place. A change is a new directory.

**Prefix** (system block, cached). Each part has trailing whitespace removed, and parts are joined with one blank line:

1. `role.md`
2. `voice-card.md`
3. `landing-v1.md` or `landing-v2.md`, by the run's `LANDING_LAYOUT`
4. `# Output schemas`, then the JSON of `draft-email.v1` and the landing schema for that layout, each from `../../schemas/`, minified with its keys in file order

The prefix is byte-identical across customers, formats and retries within a run. Nothing per-customer may enter it.

**Suffix** (user message, not cached): `task.md`, followed by `retry.md` on a retry only.

| placeholder | value |
|---|---|
| `{{format}}` | `email` or `landing_page` |
| `{{n}}` | the number of picks |
| `{{occasion_key}}` | `plan.occasion.key` |
| `{{occasion_what}}`, `{{occasion_not_for}}` | that key's `what` and `not_for` in `config/occasion_map.json` |
| `{{title_words}}` | the sum over picks of whitespace-separated chunks in each title, the same count the word limit uses, so a standalone dash counts as a word |
| `{{picks}}` | JSON array of `{slot, title, body}`, where `body` is `body_text_clean`. No other field |
| `{{summary}}` | JSON of `CustomerSummary` |
| `{{checks}}` | one line per failed check: `<id>: <detail>` |

`voice-card.sources.json` holds the source of every line in the voice card, and of the brand claim. Anchors and the brand claim must be found verbatim in a stored voice page or a snapshot body. No URL or date goes into the prompt itself, because a draft that repeated one would fail.
