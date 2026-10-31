# Prompt v1

A version is never edited in place once it has run. A change is then a new directory. Status: draft, briefs 45 and 49, not run.

**Prefix** (system block, cached). Each part has trailing whitespace removed, and parts are joined with one blank line:

1. `role.md`
2. `voice-card.md` (`voice_guide_version` `v1`; differs from v0)
3. `email.md`
4. `landing-v2.md`
5. `# Output schemas`, then the JSON of `draft-email.v2` and `draft-landing.v3` from `../../schemas/`, minified with keys in file order

The prefix is byte-identical across customers, `runs.format` values, attempts and new users. Nothing per-customer or per-run may enter it. `runs.format` and a part-scoped retry change only `output_config.format` (`draft-both.v1`, or one part's schema), which is the accepted cache miss.

**Suffix** (user message, not cached): `task.md`, followed by `retry.md` on a retry only. There is no new-user file: a customer with no history takes the same two files.

| placeholder | value |
|---|---|
| `{{parts}}` | `email and landing_page`, `email` or `landing_page`. From `runs.format` on attempt 1. On a retry: the failed part, or both on a C1 failure or a `max_tokens` stop |
| `{{n}}` | the number of picks |
| `{{occasion_key}}` | `plan.occasion_key`, or `null` |
| `{{shape}}` | from `config/shapes.json` over the raw occasion, else `open` |
| `{{title_words}}`, `{{title_words_email}}` | the prose word counter's total over all picks' titles, and over p1 to p3 |
| `{{occasion}}` | the raw occasion column, trimmed, with `<` and `>` removed. Blank: the season string if the run has one, else `none` |
| `{{picks}}` | JSON array of `{slot, group, title, body}`, where `body` is `body_text_clean` and `group` is `wear` or `home`. No other field |
| `{{quotes}}` | JSON array of `{id, text}` eligible for this plan: key among the quote's keys, and E6 needs a pick with group `home`. Null key: `[]` |
| `{{checks}}` | one line per failed check of the parts being rewritten: `<part>.<id>: <detail>` |

Gone from v0: `{{format}}`, `{{occasion_what}}`, `{{occasion_not_for}}`, `{{summary}}`, `landing-v1.md`. Customer name, last name, past note and tags never reach any file here.

`voice-card.sources.json` holds the source of every line in the voice card, and of the brand claim. No URL or date goes into the prompt itself, because a draft that repeated one would fail.
