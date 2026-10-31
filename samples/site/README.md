# Site sample

The frozen copy of nicobar.com that the build reads. Nothing here is fetched at run time.

- `catalog.json`: every `/products.json` row of the 2026-10-29 snapshot, as served, with gift cards removed (`gift_cards_removed` keeps the count). `npm run build` turns this into the snapshot, and the rebuild gives the same `snapshot_id` that `data/recommendations.synthetic.json` pins.
- `pages/`: the HTML and Atom feed that `config/prompt/v1/voice-card.sources.json` cites, plus `the-art-of-mukaish`, as served. `landing-in-serendip` is read from the feed.
- `urls.json`: source URL, fetch date and sha256 of each file.

No image file is stored. Image URLs stay in `catalog.json` and point at `cdn.shopify.com`.
