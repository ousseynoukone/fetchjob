import { Injectable } from '@nestjs/common';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'this', 'that',
  'from', 'have', 'will', 'about', 'into', 'more', 'than', 'not', 'all',
  'can', 'who', 'has', 'was', 'were', 'been', 'etre', 'avoir', 'nous',
  'vous', 'votre', 'notre', 'pour', 'avec', 'dans', 'les', 'des', 'une',
  'sur', 'plus', 'est', 'que', 'qui', 'aux', 'par', 'ans', 'chez',
]);

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

export interface MatchResult {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
}

function normalize(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(DIACRITICS_REGEX, '');
}

function extractKeywords(text: string): string[] {
  const words = normalize(text).match(/[a-z0-9+#.]{3,}/g) || [];

  const counts = new Map<string, number>();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

function wordOverlap(a: string, b: string): number {
  const setA = new Set(normalize(a).match(/[a-z0-9]{3,}/g) || []);
  const setB = new Set(normalize(b).match(/[a-z0-9]{3,}/g) || []);
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;

  return shared / Math.max(setA.size, setB.size);
}

@Injectable()
export class MatchingService {
  match(
    cv: { headline?: string; location?: string; skillGroups?: { items: string[] }[] },
    offer: { title: string; description: string; location?: string },
    targetKeywords: string[] = [],
  ): MatchResult {
    const cvSkills = (cv.skillGroups || []).flatMap((g) => g.items || []);
    const cvSkillsNorm = cvSkills.map((s) => normalize(s));

    const offerText = normalize(`${offer.title} ${offer.description}`);
    const offerKeywords = extractKeywords(`${offer.title} ${offer.description}`);

    const matchedSkills = cvSkills.filter((_, idx) => offerText.includes(cvSkillsNorm[idx]));

    // A single job posting — especially a short excerpt — will only ever
    // mention a handful of technologies, regardless of how many skills the
    // CV lists in total. Scoring against the CV's full inventory punishes
    // broad, diverse skillsets; a handful of real matches should already
    // count as strong coverage, capped rather than ratio'd against everything.
    const SKILL_TARGET = 6;
    const skillCoverage = Math.min(1, matchedSkills.length / SKILL_TARGET);
    const titleMatch = wordOverlap(cv.headline || '', offer.title || '');
    // A region-level CV location (e.g. "Ile-de-France") shares no words with
    // a specific offer location (e.g. "Paris - 75"), so a zero word-overlap
    // is inconclusive, not a confirmed mismatch — treat it the same as
    // missing data (0.5) rather than actively penalizing it to 0.
    const locationMatch =
      cv.location && offer.location
        ? wordOverlap(cv.location, offer.location) > 0 ||
          normalize(offer.location).includes('remote') ||
          normalize(offer.location).includes('teletravail')
          ? 1
          : 0.5
        : 0.5;

    // How many of the campaign's targeted roles/technologies actually show
    // up in this offer — independent of what's on the CV, since the search
    // list can include aspirational titles/stacks beyond current skills.
    // Same capped-target logic: a few real hits from a 200+ term list is
    // already a strong signal, not a small fraction of the whole list.
    const KEYWORD_TARGET = 5;
    const matchedTargets = targetKeywords.filter((kw) => kw.trim() && offerText.includes(normalize(kw)));
    const keywordCoverage = targetKeywords.length > 0 ? Math.min(1, matchedTargets.length / KEYWORD_TARGET) : 0;

    const hasTargets = targetKeywords.length > 0;
    const weights = hasTargets
      ? { skill: 0.4, title: 0.1, location: 0.15, keyword: 0.35 }
      : { skill: 0.7, title: 0.15, location: 0.15, keyword: 0 };

    const score = Math.round(
      100 *
        (weights.skill * skillCoverage +
          weights.title * titleMatch +
          weights.location * locationMatch +
          weights.keyword * keywordCoverage),
    );

    const combinedMatched = [...new Set([...matchedSkills, ...matchedTargets])];
    const combinedMatchedNorm = new Set(combinedMatched.map((s) => normalize(s)));

    const missingSkills = offerKeywords
      .filter((kw) => !combinedMatchedNorm.has(kw) && !cvSkillsNorm.some((s) => s.includes(kw)))
      .slice(0, 8);

    return {
      score: Math.min(100, Math.max(0, score)),
      matchedSkills: combinedMatched,
      missingSkills,
    };
  }
}
