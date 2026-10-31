# config/live.json

Type: `LiveFile { egress_handles: string[]; signature_agent_form: 'dictionary' | 'bare' | null }`.

- `signature_agent_form` is `null` until the egress test passes (§6, step 3). The test then writes the working form here. Nothing else may set it.
- `egress_handles`: three fixed handles for the three signed `.js` GETs of the egress test. Fixed so a re-run reads the same URLs.

## Where the handles come from

Picked from the cached full pull of `https://www.nicobar.com/products.json?limit=250&page=1..65`, fetched 2026-10-29 12:01–12:04 UTC (16,069 rows). No new request was made to choose them. Each handle:

- is in the usable set in that pull: not a gift card or bundle, has a `Filtercategory_*` tag, not `pfs:hidden`, has a non-empty `body_html` and an image, and at least one variant `available` (2,246 products meet this test as applied here);
- is one lowercase ASCII slug of the form `[a-z0-9-]+`;
- covers a different `Filtercategory_` so one category being delisted does not fail the test.

| handle | category | product_type | variants available at the pull | published_at | URL |
|---|---|---|---|---|---|
| `baraati-kurti-embroidered-mukaish-cotton-silk` | Women | Women Shirts & Tops | 4 of 5 | 2026-10-18 | https://www.nicobar.com/products/baraati-kurti-embroidered-mukaish-cotton-silk |
| `myra-tray` | House & Home | Bowls | all | 2025-11-20 | https://www.nicobar.com/products/myra-tray |
| `meher-earrings-gold` | Jewellery | Earrings | all | 2025-11-10 | https://www.nicobar.com/products/meher-earrings-gold |

`baraati-kurti-…` is the only one of the three that has also been read live: `/products/<handle>.js` and `.json` both returned 200 on 2026-10-29 18:53 UTC. `myra-tray` and `meher-earrings-gold` have not been read live; they come from the 2026-10-29 pull only. A product can sell out or be delisted after the pull, so a 404 or a changed `available` flag on one handle is a sign about that product, not about egress. The test treats only a 429 or a challenge page as an egress failure.
