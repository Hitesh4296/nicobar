// reports/cases.json: all 80 held-out cases in plain words, so the second set's text ships with the repo. The sealed sets are read, never edited.
//   node scripts/cases.ts --sealed2 <path to heldout2.json>
// Run before `npm run eval`: code results come from the committed reports/eval.json, whose `heldout_v2` an eval run drops.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { j3Input } from '../src/lib/jev/index.ts';
import type { DraftRow, Format } from '../src/contracts/types.ts';
import { heldoutCatalog, heldoutPlan } from './eval.ts';

if (!process.argv.includes('--sealed2')) throw new Error('--sealed2 <path> is required');
const SEALED2_SHA = 'b59bb69854fe3b9c73842da735b4711335397f5309df991004589ccdd49a26a2';
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const { values } = parseArgs({ options: { sealed2: { type: 'string' } } });

const KIND: Record<string, string> = { product: 'Made-up product', made_up_product: 'Made-up product', discount: 'Discount or pressure', discount_urgency: 'Discount or pressure', length: 'Too long', body_over_120: 'Too long',
  echo: 'Mentions a past purchase', purchase_echo: 'Mentions a past purchase', image: 'Image not from nicobar.com', image_off_site: 'Image not from nicobar.com' };
/** The j3 questions that could catch a kind. Length and images are not a judge's question. */
const QUESTIONS: Record<string, string[]> = { 'Made-up product': ['names_unselected_product'], 'Discount or pressure': ['discount', 'pressure'], 'Mentions a past purchase': ['claims_customer'], 'Too long': [], 'Image not from nicobar.com': [] };

/** Plant and reason for each case. Length rows get their count from the check; image rows plant their address. */
const PLANT: Record<string, [string[], string]> = {
  'H-01': [['a single emerald'], 'The necklace has a garnet at its centre, not an emerald.'],
  'H-02': [['waxed canvas'], 'The pouch is printed cotton twill, not waxed canvas.'],
  'H-03': [['A matching pair of Noorani drop earrings'], 'No such earrings were chosen for this customer; the only Noorani piece chosen is the necklace.'],
  'H-04': [['a wide straw hat', 'flat leather sandals'], 'The hat and the sandals are not among the chosen products, so the copy sells things nobody picked.'],
  'H-05': [['They also come in a deeper size for soups'], 'The bowls have no deeper size; the copy invents a variant.'],
  'H-06': [['Gold-plated brass with a small aeroplane'], 'The Flight Bracelet is silver; the caption calls it gold-plated.'],
  'H-07': [['Guldasta Edit'], 'There is no collection called the Guldasta Edit.'],
  'H-08': [['a matching card holder in the same print'], 'No card holder was chosen for this customer.'],
  'H-09': [['rarely last on the shelf past Diwali week, so choose early'], 'It pressures the reader with scarcity and a date, which Nicobar copy never does.'],
  'H-10': [['priced kindly'], 'It talks about price, and Nicobar copy says nothing about money.'],
  'H-11': [['Order by Thursday'], 'It sets a deadline to buy by.'],
  'H-12': [['among the last few'], 'It claims stock is nearly gone, which is scarcity pressure.'],
  'H-13': [['without spending more than you meant to'], 'It sells on saving money with no discount word in it.'],
  'H-14': [['now 20% off until Sunday'], 'It offers a percentage off, and there are no live markdowns.'],
  'H-15': [['Be quick', 'does not always stay in stock'], 'It hurries the reader with a claim about stock.'],
  'H-16': [['a small spend'], 'It sells on the price being small.'],
  'H-25': [["Last winter's silk"], 'It brings up the silk stole this customer bought last winter.'],
  'H-26': [['A printed shirt from last summer'], 'It brings up the resort shirt this customer bought last summer.'],
  'H-27': [['the same length you have been packing a weekender for'], 'It brings up the weekender this customer bought and how they use it.'],
  'H-28': [['a second hot-weather holiday when the shirts will not do'], 'It hints at the resort shirt this customer bought for a hot-weather trip.'],
  'H-29': [['Brass has been a gift before'], 'It brings up the brass ear cuffs this customer bought as a gift.'],
  'H-30': [['the blue shirt that went with you'], 'It brings up the indigo shirt this customer took on a coastal trip.'],
  'H-31': [['the way you handled them before, in block print'], 'It brings up the block-print scarf this customer bought for a cool evening.'],
  'H-32': [['You landed in a kurta'], 'It brings up the kurta this customer wore off the plane.'],
  'h2-01': [[], 'The copy is clean: the planted Rose Gold variant sat only in a "Featured" line that the real page builds from the chosen product, so this one cannot happen in a real draft.'],
  'h2-02': [['in silver'], 'The chosen necklace is gold; there is no silver version on the page.'],
  'h2-03': [['A set of six'], 'The chosen mugs are not sold as a set of six.'],
  'h2-04': [['Lakshmi Diya Stand'], 'No such product exists in the catalogue.'],
  'h2-05': [['Jaipur Weekender Duffel'], 'No such product exists in the catalogue.'],
  'h2-06': [['in copper'], 'The chosen pot is brass, not copper.'],
  'h2-07': [['In cashmere'], 'The chosen scarf is pure silk, not cashmere.'],
  'h2-08': [['The Alphabet Glass in R'], 'The chosen glass is the letter V; the copy sells a different letter.'],
  'h2-09': [['Pick it up this week, while the colours are still in stock'], 'It hurries the reader with a time and a claim about stock.'],
  'h2-10': [['A fair price'], 'It talks about price, and Nicobar copy says nothing about money.'],
  'h2-11': [['before the weekend ends', 'will not stay on the shelf long'], 'It hurries the reader with a deadline and a claim about stock.'],
  'h2-12': [['Order within the next two days'], 'It sets a deadline to buy by.'],
  'h2-13': [['at no charge today'], 'It offers something free for today only, which is a promotion.'],
  'h2-14': [['the last few pairs'], 'It claims stock is nearly gone, which is scarcity pressure.'],
  'h2-15': [['costs less than you would expect'], 'It sells on the price being low.'],
  'h2-16': [['Do not wait', 'going fast'], 'It hurries the reader with a claim that stock is running out.'],
  'h2-25': [['You wore the indigo travel shirt'], 'It brings up the indigo shirt this customer bought.'],
  'h2-26': [['The silk evening stole you bought last winter'], 'It brings up the silk stole this customer bought.'],
  'h2-27': [['The weekender has served you'], 'It brings up the weekender this customer bought and how they use it.'],
  'h2-28': [['the silver stack you gave for a birthday'], 'It brings up the silver stack this customer bought for a birthday.'],
  'h2-29': [['Your woven weekender'], 'It brings up the weekender this customer bought.'],
  'h2-30': [['The handloom throw you chose'], 'It brings up the handloom throw this customer bought.'],
  'h2-31': [['the stole you lent out twice'], 'It brings up the stole this customer owns and what they did with it.'],
  'h2-32': [['The block-print scarf kept you warm'], 'It brings up the block-print scarf this customer bought.'],
};
const IMAGE: Record<string, string> = {
  'H-33': 'The address uses a look-alike of the real image host.', 'H-34': 'The address is not on a secure connection.', 'H-35': 'The address has extra path after the file, so it is not the real file.',
  'H-36': 'This is a real image, but of a different product from the one on the card.', 'H-37': 'This is a resized image of a different chosen product.', 'H-38': 'The image is hotlinked from the shop pages and not from its image host.',
  'H-39': 'The store number in the address has two digits swapped, so it points at another store.', 'H-40': 'The real host sits before an @, and the image actually comes from another site.',
  'h2-33': 'The image comes from Unsplash, not from nicobar.com.', 'h2-34': 'The address only looks like nicobar.com; it is a different site.', 'h2-35': 'This is a real image, but of a different product.',
  'h2-36': 'The address points at another store on the image host.', 'h2-37': 'The image is embedded in the page and not served from nicobar.com.', 'h2-38': 'The image comes from Pinterest, not from nicobar.com.',
  'h2-39': 'The address leaves out its scheme and points at a mirror site.', 'h2-40': 'The address is on the right host, but no chosen product has this image.',
};

const raw = readFileSync(values.sealed2!);
if (createHash('sha256').update(raw).digest('hex') !== SEALED2_SHA) throw new Error('heldout2.json is not the sealed file');
const set2 = JSON.parse(raw.toString()) as any[];
const set1 = read('test/cases/heldout.json').cases as any[];
const report = read('reports/eval.json');
if (!report.heldout_v2) throw new Error('reports/eval.json has no heldout_v2: git checkout it first');
const rows = new Map((read('test/cases/heldout-pack.json').rows as any[]).map((r) => [r.customer_id, r]));
const results = new Map([...report.heldout_v1.current.cases, ...report.heldout_v2.cases].map((c: any) => [c.id, c]));
const blindMisses = new Set(report.heldout_v1.scored.misses as string[]);
const cat = heldoutCatalog();

function textOf(part: Format, model: object, row: any): string {
  const { plan, envelope } = heldoutPlan(row, part, cat);
  const input = j3Input({ envelope_json: JSON.stringify(envelope), model_json: JSON.stringify({ [part]: model }) } as DraftRow, plan, cat);
  return input[part]!;
}

/** The sealed text as a draft: heading to subject, body verbatim, `Featured:` and `Image:` dropped. */
function convert(c: any) {
  const lines = c.draft.split('\n');
  const end = lines.findIndex((l: string) => l.startsWith('Featured:'));
  const image = lines.find((l: string) => l.startsWith('Image:'))?.slice('Image: '.length);
  return { image, model: { occasion_key: rows.get(c.customer_id).occasion_key, subject: lines[0], preheader: '', body: lines.slice(2, end).join('\n').trim() } };
}

function words(id: string): string {
  const r = results.get(id);
  const n = r.body_words ?? r.hits.find((h: any) => h.code === 'OVER_WORDS')?.detail;
  if (!n) throw new Error(`${id}: no word count`);
  return `The copy runs to ${n} words; the limit is 120.`;
}

const cases = [...set1.map((c) => ({ c, set: 'First set', part: c.part, url: c.url as string | undefined, model: c.draft })),
  ...set2.map((c) => { const { image, model } = convert(c); return { c, set: 'Second set', part: 'email', url: c.class === 'image_off_site' ? image : undefined, model }; })].map(({ c, set, part, url, model }) => {
  const row = rows.get(c.customer_id), kind = KIND[c.class], r = results.get(c.id);
  if (!row || !kind || !r) throw new Error(`${c.id}: no row, kind or result`);
  const text = url ?? textOf(part, model, row);
  const [planted, why] = kind === 'Too long' ? [[], words(c.id)] : url ? [[url], IMAGE[c.id]] : PLANT[c.id];
  return { id: c.id, set, kind, customer: c.customer_id, occasion: row.occasion, past_note: row.past_purchase_note ?? null, part, planted, why, text, model: url ? null : model,
    questions: c.id === 'h2-01' ? [] : QUESTIONS[kind],
    code: { caught: r.caught, blocked: r.blocked, fired: r.fired, ...(set === 'First set' ? { first_pass_caught: !blindMisses.has(c.id) } : {}) } };
});

const missing = cases.filter((c) => !c.why || c.planted.some((p: string) => !c.text.includes(p)));
if (cases.length !== 80 || missing.length) throw new Error(`bad cases: ${cases.length}, ${JSON.stringify(missing.map((c) => [c.id, c.planted]))}`);
writeFileSync('reports/cases.json', `${JSON.stringify({ note: 'Generated by scripts/cases.ts. Set 1 was used to tune the checks; set 2 was scored once, blind. Synthetic customers.', cases }, null, 1)}\n`);
console.log(JSON.stringify({ cases: cases.length, blocked: cases.filter((c) => c.code.blocked).length, caught: cases.filter((c) => c.code.caught).length }));
