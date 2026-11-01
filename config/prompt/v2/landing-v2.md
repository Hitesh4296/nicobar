# Part: landing page

You arrange the page from fixed components and write their prose. Choose the arrangement that suits this occasion and these picks. Code renders each component.

- occasion_key: the key given in the task, exactly. If it is null, return null.
- sections: 3 to 6 components, in reading order.

| type | what you give | limits |
|---|---|---|
| hero | slot, heading, line | Shows one pick large. heading: 2 to 8 words, no token. line: 8 to 25 words, and no token but this pick's |
| story | text | 15 to 50 words. Any pick's token |
| product_grid | items, each with slot and caption | 2 to 4 cards. caption: 4 to 18 words, no token |
| pairing | slots (2), line | Two picks of the same group that belong together. line: 8 to 30 words, and no token but these two |
| quote | quote_id | A line from Nicobar's own pages. You write nothing |
| packing_list | items, each with slot and note | Only when the shape is trip. 3 to 5 rows, in the order they go in the bag. note: 3 to 10 words, no token |
| feature | slot, line | One pick shown large with its own text. line: 12 to 30 words, and no token but this pick's |

A hero heading and line, a caption, a note, and a feature line belong to their own pick, and a pairing line to its two picks. They may describe that pick without its token, and they describe nothing else.

The task gives a shape. It is the job of this page, and it sets one rule. Everything else is yours to arrange.

| shape | the page's job | rule |
|---|---|---|
| trip | what goes in the bag, in order | exactly 1 packing_list |
| gift | one thing for one person | at least 1 feature. A story, if any, frames the person receiving it |
| home | things on one table | at least 1 product_grid |
| wedding | what is worn together | at least 1 pairing |
| scene | one scene, then the pieces | the second section is a story |
| open | what the picks are for | no rule |

Layout rules:

1. The first section is a hero, and there is only one. Its slot is always p1: code ranked the picks, and this is the one placement not left to you. Every other pick is yours to place. No shape rule changes this: a wedding pairing takes two of the other picks.
2. Every pick appears in exactly one hero, product_grid, pairing, packing_list or feature. Story and quote show no pick. Divide the picks first: the hero takes p1, and the rest go in groups that add up. A product_grid needs at least 2 and a packing_list at least 3, so with 4 picks a pairing leaves one for a feature.
3. At most 2 stories, 1 quote, 1 packing_list and 2 features. Never place a story and a quote, or two stories, next to each other.
4. Use a quote only if <quotes> lists it. It is your choice. If <quotes> is empty, use no quote.

Each token appears at most once across the whole page. A card already shows its title, so use few tokens: each one costs all the words of its title. Reader-visible prose is every heading, line, story, caption and note. Rendered titles and the quote do not count, but a token in your prose does.
