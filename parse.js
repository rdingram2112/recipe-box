'use strict';
/* Turns ingredient lines like "1 (15 oz) can black beans, drained" into something
   the shopping list can add up, and matches each one to a price-book item. */

const FRACTIONS = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅕': '1/5', '⅙': '1/6' };

// Measured units: dimension and size in a base unit (ml for volume, g for weight).
const MEASURES = {
  tsp: ['vol', 4.93], tbsp: ['vol', 14.79], cup: ['vol', 236.6], floz: ['vol', 29.57], pint: ['vol', 473],
  quart: ['vol', 946], gallon: ['vol', 3785], ml: ['vol', 1], l: ['vol', 1000],
  oz: ['wt', 28.35], lb: ['wt', 453.6], g: ['wt', 1], kg: ['wt', 1000],
};
const UNIT_WORDS = {
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp', tsps: 'tsp', t: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tbls: 'tbsp',
  cup: 'cup', cups: 'cup', c: 'cup',
  ounce: 'oz', ounces: 'oz', oz: 'oz',
  pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb',
  gram: 'g', grams: 'g', g: 'g', kilogram: 'kg', kilograms: 'kg', kg: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', liter: 'l', liters: 'l', litre: 'l',
  pint: 'pint', pints: 'pint', pt: 'pint', quart: 'quart', quarts: 'quart', qt: 'quart', gallon: 'gallon', gallons: 'gallon', gal: 'gallon',
  // Counted units
  clove: 'clove', cloves: 'clove', can: 'can', cans: 'can', jar: 'jar', jars: 'jar', package: 'package', packages: 'package', pkg: 'package',
  packet: 'packet', packets: 'packet', envelope: 'packet', box: 'box', boxes: 'box', bag: 'bag', bags: 'bag', bottle: 'bottle', bottles: 'bottle',
  carton: 'carton', cartons: 'carton', container: 'package', bunch: 'bunch', bunches: 'bunch', head: 'head', heads: 'head',
  stalk: 'stalk', stalks: 'stalk', rib: 'rib', ribs: 'rib', sprig: 'sprig', sprigs: 'sprig', slice: 'slice', slices: 'slice',
  strip: 'strip', strips: 'strip', stick: 'stick', sticks: 'stick', link: 'link', links: 'link', piece: 'piece', pieces: 'piece',
  leaf: 'leaf', leaves: 'leaf', handful: 'handful', handfuls: 'handful', pinch: 'pinch', pinches: 'pinch', dash: 'dash', dashes: 'dash',
  inch: 'inch', inches: 'inch', ear: 'ear', ears: 'ear', fillet: 'each', fillets: 'each', whole: 'each', each: 'each',
  large: 'each', medium: 'each', small: 'each', jumbo: 'each',
};
const CONTAINERS = new Set(['can', 'jar', 'package', 'packet', 'box', 'bag', 'bottle', 'carton']);
const TINY = new Set(['pinch', 'dash']);
const PREP_WORDS = new Set(('diced chopped minced sliced finely roughly thinly coarsely freshly fresh peeled seeded deseeded cored trimmed ' +
  'halved quartered cubed julienned packed heaping level about approximately divided softened melted room temperature' +
  'drained rinsed and undrained uncooked cooked boneless skinless optional lightly beaten whisked shredded grated torn crumbled ' +
  'large medium small extra jumbo ripe good quality homemade store-bought storebought plus more needed').split(' '));
const KEEP_WITH = new Set(['boneless', 'skinless', 'shredded', 'grated']); // kept when part of a known product name

function frac(s) {
  s = String(s).trim();
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s); if (m) return +m[1] + m[2] / m[3];
  m = /^(\d+)\/(\d+)$/.exec(s); if (m) return m[1] / m[2];
  return parseFloat(s) || 0;
}

function singular(w) {
  if (w.length <= 3) return w;
  if (w === 'leaves') return 'leaf';
  if (/^chil(e|es|i|ies|is|ly)$/.test(w)) return 'chile';
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (/[^su]s$/.test(w)) return w.slice(0, -1);
  return w;
}
const tokens = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9%]+/).filter(Boolean).map(singular);

/* Parse one ingredient line. */
function parseIngredient(raw) {
  let s = String(raw || '').replace(/[▢☐□]/g, ' ');
  s = s.replace(/(\d)\s*([½⅓⅔¼¾⅛⅜⅝⅞⅕⅙])/g, (_, d, f) => `${d} ${FRACTIONS[f]}`).replace(/[½⅓⅔¼¾⅛⅜⅝⅞⅕⅙]/g, f => FRACTIONS[f]);
  s = s.replace(/⁄/g, '/');
  const notes = [];
  s = s.replace(/\(([^)]*)\)/g, (_, n) => { notes.push(n.trim()); return ' '; }).replace(/\s+/g, ' ').trim();

  const NUM = '(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
  let qty = 0, rest = s;
  const m = new RegExp(`^${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s*`).exec(s);
  if (m) { qty = frac(m[1]); rest = s.slice(m[0].length); }
  else if (/^(a|an|one)\s/i.test(s)) { qty = 1; rest = s.replace(/^(a|an|one)\s+/i, ''); }

  let unit = '';
  const words = rest.split(' ');
  const w0 = (words[0] || '').toLowerCase().replace(/\.$/, '');
  const w1 = (words[1] || '').toLowerCase().replace(/\.$/, '');
  if ((w0 === 'fl' || w0 === 'fluid') && /^(oz|ounces?)$/.test(w1)) { unit = 'floz'; words.splice(0, 2); }
  else if (UNIT_WORDS[w0] && !(w0 === 'c' && words.length < 2)) { unit = UNIT_WORDS[w0]; words.splice(0, 1); }
  // "28 oz can tomatoes": the amount is the can's size; skip the container word.
  if (MEASURES[unit] && words[0] && CONTAINERS.has(UNIT_WORDS[words[0].toLowerCase()])) words.splice(0, 1);
  // "2 large onions": treat the size word as "each".
  if (unit === 'each' && words[0] && UNIT_WORDS[words[0].toLowerCase()] === 'each') words.splice(0, 1);

  let name = words.join(' ').replace(/^of\s+/i, '');
  name = name.split(/,|;|\s+for\s+|\s+or\s+|\s+plus\s+|\s+to taste|\s+as needed|\s+such as\s+/i)[0];
  const nameWords = name.toLowerCase().replace(/[^a-z0-9%\-' ]/g, ' ').split(/\s+/).filter(Boolean);
  const cleaned = nameWords.filter(w => !PREP_WORDS.has(w) || KEEP_WITH.has(w));
  const key = (cleaned.length ? cleaned : nameWords).join(' ').trim();
  // "2 chicken breasts (about 2 lbs.)": prefer the weight in the note over the count.
  if (!MEASURES[unit] && !CONTAINERS.has(unit)) {
    const w = /(\d+(?:\.\d+)?|\d+\/\d+)\s*(lbs?|pounds?|oz|ounces?)\b/i.exec(notes.join(' '));
    if (w) { const u = UNIT_WORDS[w[2].toLowerCase()]; qty = frac(w[1]); unit = u; }
  }
  return { raw: String(raw || '').replace(/[▢☐□]/g, '').trim(), qty, unit, key, full: nameWords.join(' '), note: notes.join('; ') };
}

/* ---------- price-book matching ---------- */

let MATCH_INDEX = [];
/* entries: built-in PRICE_BOOK merged with your saved prices (custom items included). */
function buildMatchIndex(entries) {
  MATCH_INDEX = [];
  for (const e of entries) for (const n of e.names) {
    const t = tokens(n); if (t.length) MATCH_INDEX.push({ e, t, phrase: t.join(' ') });
  }
}
function matchEntry(key) {
  const kt = tokens(key); if (!kt.length) return null;
  const set = new Set(kt), phrase = ' ' + kt.join(' ') + ' ';
  let best = null, bestScore = 0;
  for (const c of MATCH_INDEX) {
    if (!c.t.every(t => set.has(t))) continue;
    const score = c.t.length * 10 + (phrase.includes(' ' + c.phrase + ' ') ? 5 : 0) + (c.phrase === kt.join(' ') ? 20 : 0);
    if (score > bestScore) { best = c.e; bestScore = score; }
  }
  return best;
}

function parseSize(size) {
  const s = String(size || '').toLowerCase();
  const m = /(\d*\.?\d+)\s*(fl\.?\s*oz|oz|lb|lbs|gallon|quart|pint|ml|l|ct|count|g|kg)\b/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  let u = m[2].replace(/\s|\./g, '');
  if (u === 'floz') return { dim: 'vol', base: n * 29.57 };
  if (u === 'ct' || u === 'count') return { dim: 'count', base: n };
  if (u === 'lbs') u = 'lb';
  const [dim, f] = MEASURES[u] || [];
  return dim ? { dim, base: n * f, oz: u === 'oz' ? n : 0 } : null;
}

/* How much of an item to buy for one ingredient: number of items ("ea"), pounds ("lb"),
   or packages ("pk"). Rough when the recipe uses a measure the package doesn't. */
function amountToBuy(p, e) {
  const q = p.qty || 1, u = p.unit;
  if (TINY.has(u)) return e.by === 'lb' ? 0.02 : 0.02;
  const per = e.per || {};
  if (per[u]) return (q / per[u]) * (e.by === 'lb' ? (e.lbEach || 1) : 1);
  const meas = MEASURES[u];
  const isCount = !u || u === 'each' || u === 'ear' || u === 'piece' || u === 'head' || u === 'bunch';
  if (e.by === 'lb') {
    if (meas && meas[0] === 'wt') return q * meas[1] / 453.6;
    if (isCount) return q * (e.lbEach || 0.5);
    return 0.5;
  }
  if (e.by === 'ea') {
    if (isCount || CONTAINERS.has(u)) return q;
    return per.each ? q / per.each : 1;
  }
  // sold by package
  if (CONTAINERS.has(u)) return q;
  const pkg = parseSize(e.size);
  if (isCount) {
    if (per.each) return q / per.each;
    if (pkg && pkg.dim === 'count') return q / pkg.base;
    return q;
  }
  if (pkg && meas) {
    let pkgBase = pkg.base, ingBase = q * meas[1];
    if (meas[0] === 'vol' && pkg.dim === 'wt' && pkg.oz) pkgBase = pkg.oz * 29.57;        // "16 oz" sour cream measured in cups
    else if (meas[0] === 'wt' && u === 'oz' && pkg.dim === 'vol') ingBase = q * 29.57;     // "8 oz broth"
    else if (meas[0] !== pkg.dim) return 1;
    return ingBase / pkgBase;
  }
  return 1;
}

const AISLE_GUESS = [
  [/chicken|beef|pork|turkey|steak|shrimp|salmon|fish|sausage|bacon|lamb|veal|ground meat|roast/, 'Meat & Seafood'],
  [/cheese|milk|cream|yogurt|butter|egg/, 'Dairy & Eggs'],
  [/seasoning|powder|dried|spice|ground |flakes|extract/, 'Spices & Seasonings'],
  [/flour|sugar|baking|yeast|cocoa|sprinkles/, 'Baking'],
  [/frozen/, 'Frozen'],
  [/pasta|noodle|rice|spaghetti|macaroni|oat|quinoa|couscous/, 'Pasta, Rice & Grains'],
  [/canned|beans|broth|stock|tomato sauce|paste/, 'Canned & Jarred'],
  [/sauce|oil|vinegar|dressing|syrup|honey|mustard|ketchup|mayo|nut|chips|crackers/, 'Pantry'],
  [/bread|bun|roll|tortilla|bagel|croissant/, 'Bakery & Bread'],
  [/wine|beer|juice|soda|coffee|tea/, 'Beverages'],
  [/lettuce|onion|pepper|tomato|potato|apple|berr|herb|lime|lemon|squash|greens|celery|carrot|cucumber|avocado|cilantro|parsley|basil|mint|ginger|garlic/, 'Produce'],
];
function guessAisle(key) {
  for (const [re, a] of AISLE_GUESS) if (re.test(key)) return a;
  return 'Other';
}

/* Split pasted recipe text into title, ingredient lines and steps. */
function parseRecipeText(text) {
  const lines = String(text || '').split(/\r?\n/)
    .map(l => l.replace(/[▢☐□]/g, '').replace(/,?\s*\$\d+(?:\.\d+)?\**/g, '').replace(/\(\s*,?\s*\)/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const isIngHead = l => /^(ingredients?|you('| wi)ll need)\b[:]?$/i.test(l) || /^ingredients\b/i.test(l) && l.length < 25;
  const isStepHead = l => /^(instructions|directions|method|steps|preparation|how to make( it)?)\b/i.test(l) && l.length < 30;
  const iIng = lines.findIndex(isIngHead), iStep = lines.findIndex(isStepHead);
  let title = lines[0] || 'Untitled recipe', ings = [], steps = [];
  if (iIng >= 0 && iStep > iIng) {
    ings = lines.slice(iIng + 1, iStep);
    steps = lines.slice(iStep + 1);
    if (iIng > 0) title = lines[0];
  } else {
    for (const l of lines.slice(1)) {
      if (/^([\d½⅓⅔¼¾⅛]|a |an )/i.test(l) && l.length < 90) ings.push(l);
      else if (l.length > 30) steps.push(l);
    }
  }
  const cut = steps.findIndex(l => /^(notes?|nutrition|video|did you make)/i.test(l));
  if (cut >= 0) steps = steps.slice(0, cut);
  steps = steps.map(l => l.replace(/^(step\s*)?\d+[.):]?\s+/i, '')).filter(l => l.length > 3);
  return { title: title.slice(0, 120), ingredients: ings.slice(0, 60), steps: steps.slice(0, 40) };
}
