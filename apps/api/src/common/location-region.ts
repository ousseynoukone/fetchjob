// Shared by campaign.service.ts (the search-time isWithinIdf filter) and
// matching.service.ts (the score's locationMatch component) so both are
// driven by the exact same underlying check instead of two different,
// only loosely related ones -- confirmed live that the mismatch between
// them (a strict filter upstream, paired with a weak word-overlap re-check
// at scoring time that almost never reached a positive match even for an
// offer the filter had already confirmed) was silently costing every
// single offer reaching the scorer about half of the location weight,
// capping even genuinely strong matches well below a realistic score.

// Confirmed live: LinkedIn's own location field is often just a bare commune
// name with NO department code or region name anywhere in the string at all
// ("Issy-les-Moulineaux", "Nanterre", "Neuilly-sur-Seine") -- the department-
// code regex below can only ever help when a code is actually present, so a
// real run still wrongly rejected 104 offers in well-known Paris-area
// communes as "not Ile-de-France". Not an exhaustive commune list (~1300
// exist in the region) -- covers the ones that actually kept recurring
// across real runs tonight, mostly petite-couronne tech hubs.
const IDF_LOCATION_NAME_TERMS = [
  'ile de france', 'paris', 'seine et marne', 'yvelines', 'essonne',
  'hauts de seine', 'seine saint denis', 'val de marne', 'val d oise',
  'boulogne billancourt', 'issy les moulineaux', 'neuilly sur seine',
  'nanterre', 'courbevoie', 'levallois perret', 'clichy', 'puteaux',
  'colombes', 'asnieres sur seine', 'rueil malmaison', 'clamart',
  'montrouge', 'suresnes', 'vanves', 'gennevilliers', 'bagneux',
  'chatillon', 'saint cloud', 'sevres', 'meudon', 'antony',
  'chatenay malabry', 'la defense', 'saint denis', 'aubervilliers',
  'montreuil', 'pantin', 'bobigny', 'noisy le grand', 'bondy',
  'aulnay sous bois', 'drancy', 'le blanc mesnil', 'sevran',
  'saint ouen', 'romainville', 'vitry sur seine', 'creteil',
  'ivry sur seine', 'champigny sur marne', 'saint maur des fosses',
  'maisons alfort', 'alfortville', 'villejuif', 'fontenay sous bois',
  'nogent sur marne', 'charenton le pont', 'le perreux sur marne',
  'versailles', 'saint quentin en yvelines', 'guyancourt', 'velizy',
  'massy', 'evry', 'courcouronnes', 'palaiseau', 'orsay', 'les ulis',
  'cergy', 'argenteuil', 'bezons', 'sartrouville', 'saint germain en laye',
  'melun', 'chelles', 'marne la vallee', 'noisiel', 'torcy',
  'la garenne colombes', 'plaisir', 'trappes',
];

// Confirmed live: every real location string seen across these platforms
// formats a department code as a bare number -- "92 - ISSY LES MOULINEAUX",
// "Boulogne-Billancourt - 92" -- never wrapped in literal parentheses like
// the old "(92)" terms this replaced expected. normalizeText also strips
// dashes to spaces before this ever runs, so those old terms could never
// match ANY real offer's location, silently rejecting every IDF offer
// outside Paris itself (departments 77/78/91/92/93/94/95) as "not Ile-de-
// France" even when it genuinely was. Matched as a standalone token via
// word boundaries so a postal code ("92100") or an unrelated number doesn't
// false-positive.
const IDF_DEPARTMENT_CODE_REGEXES = ['75', '77', '78', '91', '92', '93', '94', '95'].map(
  (code) => new RegExp(`\\b${code}\\b`),
);

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .replace(/[-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 'yes' | 'unknown', deliberately not a false-capable boolean: without a
// comprehensive term/code list for every OTHER French region (only
// Ile-de-France's is built out), this can never honestly confirm a
// location is NOT in the target region, only that it couldn't confirm it
// IS.
export function locationWithinRegion(offerLocation: string | undefined, targetRegion: string | undefined): 'yes' | 'unknown' {
  const normalizedTarget = normalizeText(targetRegion || '');
  if (normalizedTarget !== 'ile de france') return 'unknown';
  if (!offerLocation) return 'unknown';

  const normalized = normalizeText(offerLocation);
  if (normalized.includes('remote') || normalized.includes('teletravail')) return 'yes';
  if (IDF_LOCATION_NAME_TERMS.some((term) => normalized.includes(term))) return 'yes';
  if (IDF_DEPARTMENT_CODE_REGEXES.some((re) => re.test(normalized))) return 'yes';
  return 'unknown';
}
