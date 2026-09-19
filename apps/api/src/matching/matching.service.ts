import { Injectable } from '@nestjs/common';
import { locationWithinRegion } from '../common/location-region';

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
  seniorityMismatch: boolean;
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

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

// Builds the seniority-title regex from the campaign's own configurable
// `seniorityKeywords` (edited in the UI, same as excludeKeywords) rather
// than a fixed list in code — checked against the title only, since
// checking the full description would false-positive on postings that
// merely mention working alongside senior engineers.
function buildSeniorityRegex(keywords: string[]): RegExp | null {
  const parts = keywords
    .map((kw) => normalize(kw.trim()))
    .filter(Boolean)
    .map((kw) => kw.replace(REGEX_SPECIAL_CHARS, '\\$&').replace(/\s+/g, '\\s+'));

  if (!parts.length) return null;
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

const YEAR_REGEX = /\b(19|20)\d{2}\b/g;

// `period` is free text (e.g. "2022 - 2024", "Sept. 2023 – Présent"), so
// years of experience can only be estimated: earliest year mentioned across
// every experience, compared to now. Good enough to separate "just starting
// out" from "several years in" without requiring structured dates on the CV.
function estimateYearsOfExperience(experiences?: { period?: string }[]): number {
  const years = (experiences || []).flatMap((e) => (e.period || '').match(YEAR_REGEX) || []).map(Number);
  if (!years.length) return 0;
  return Math.max(0, new Date().getFullYear() - Math.min(...years));
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
    cv: {
      headline?: string;
      location?: string;
      skillGroups?: { items: string[] }[];
      experiences?: { period?: string }[];
    },
    offer: { title: string; description: string; location?: string },
    targetKeywords: string[] = [],
    seniorityKeywords: string[] = [],
    // The campaign's own configured search region (e.g. "Ile de France"),
    // not a hardcoded default -- whatever the user set in the UI. Passed
    // separately from cv.location because the two can genuinely differ
    // (a candidate's CV location isn't necessarily where they're searching),
    // and because campaign.service.ts's automated pipeline already ran this
    // exact offer through isWithinIdf against this same targetRegion before
    // it ever reached here, so the score should agree with the filter
    // instead of re-deriving a weaker, independent guess.
    targetRegion?: string,
  ): MatchResult {
    const cvSkills = (cv.skillGroups || []).flatMap((g) => g.items || []);
    // Plain normalize() only lowercases/strips accents -- "React JS" (a
    // real CV entry) then never substring-matches "ReactJS" or "React.js"
    // in offer text (different spacing/punctuation, same technology).
    // Stripped down to bare alphanumerics for the comparison only, so
    // matching is insensitive to spacing/punctuation without ever crediting
    // a skill that isn't genuinely named in the offer text.
    const stripToAlnum = (s: string) => normalize(s).replace(/[^a-z0-9]/g, '');
    const cvSkillsNorm = cvSkills.map((s) => stripToAlnum(s));
    const offerTextAlnum = stripToAlnum(`${offer.title} ${offer.description}`);

    const offerText = normalize(`${offer.title} ${offer.description}`);
    const offerKeywords = extractKeywords(`${offer.title} ${offer.description}`);

    const matchedSkills = cvSkills.filter((_, idx) => cvSkillsNorm[idx] && offerTextAlnum.includes(cvSkillsNorm[idx]));

    // A single job posting -- especially a short excerpt -- will only ever
    // mention a handful of technologies, regardless of how many skills the
    // CV lists in total. Confirmed live across a full campaign run (554
    // real scored offers): even the best real matches rarely broke 4-5
    // distinct matched skills, so the old target of 6 silently capped
    // skillCoverage well under 1.0 for genuinely strong matches, dragging
    // the realistic score ceiling down to the mid-60s across the board.
    // Lowering the target doesn't inflate a WEAK match (0-1 matched skills
    // still scores near 0 on this component either way) -- it only lets a
    // GOOD match (several real, confirmed overlapping skills) reach its
    // deserved full credit instead of being permanently discounted.
    const SKILL_TARGET = 4;
    const skillCoverage = Math.min(1, matchedSkills.length / SKILL_TARGET);
    const titleMatch = wordOverlap(cv.headline || '', offer.title || '');
    // Same locationWithinRegion check campaign.service.ts's isWithinIdf
    // already ran this offer through, so a campaign-pipeline offer (already
    // confirmed in-region) scores a full 1 here instead of the old
    // word-overlap re-check, which compared a region name against a city/
    // department code and so almost never actually matched. Falls back to
    // cv.location as the target when no campaign region is known (e.g. the
    // unfiltered manual-add path with no campaign context) -- 'unknown'
    // (untargeted region, or a target region with no term list built out,
    // or simply no offer location) keeps the previous neutral 0.5 default
    // rather than guessing.
    const effectiveTargetRegion = targetRegion || cv.location;
    const locationMatch = locationWithinRegion(offer.location, effectiveTargetRegion) === 'yes' ? 1 : 0.5;

    // How many of the campaign's targeted roles/technologies actually show
    // up in this offer — independent of what's on the CV, since the search
    // list can include aspirational titles/stacks beyond current skills.
    // Same capped-target logic, same live-run-confirmed recalibration as
    // SKILL_TARGET above: a real strong match rarely hit more than 2-3
    // distinct target keywords in one posting's text, so the old target of
    // 5 was capping keywordCoverage well under 1.0 even for offers that
    // were, in practice, an excellent match.
    const KEYWORD_TARGET = 3;
    const matchedTargets = targetKeywords.filter((kw) => kw.trim() && offerText.includes(normalize(kw)));
    const keywordCoverage = targetKeywords.length > 0 ? Math.min(1, matchedTargets.length / KEYWORD_TARGET) : 0;

    const hasTargets = targetKeywords.length > 0;
    const weights = hasTargets
      ? { skill: 0.4, title: 0.1, location: 0.15, keyword: 0.35 }
      : { skill: 0.7, title: 0.15, location: 0.15, keyword: 0 };

    const rawScore =
      100 *
      (weights.skill * skillCoverage +
        weights.title * titleMatch +
        weights.location * locationMatch +
        weights.keyword * keywordCoverage);

    // A candidate still early in their career gets flooded with "Senior" /
    // "Tech Lead" / "Staff" postings that happen to share the right stack —
    // heavily discount those rather than let stack overlap alone rank them
    // as a good match. Candidates with 3+ estimated years are assumed
    // experienced enough that a senior title isn't a mismatch.
    const candidateYears = estimateYearsOfExperience(cv.experiences);
    const seniorityRegex = buildSeniorityRegex(seniorityKeywords);
    const seniorityMismatch = candidateYears < 3 && !!seniorityRegex && seniorityRegex.test(normalize(offer.title));
    const score = Math.round(seniorityMismatch ? rawScore * 0.15 : rawScore);

    const combinedMatched = [...new Set([...matchedSkills, ...matchedTargets])];
    const combinedMatchedNorm = new Set(combinedMatched.map((s) => normalize(s)));

    const missingSkills = offerKeywords
      .filter((kw) => !combinedMatchedNorm.has(kw) && !cvSkillsNorm.some((s) => s.includes(kw)))
      .slice(0, 8);

    return {
      score: Math.min(100, Math.max(0, score)),
      matchedSkills: combinedMatched,
      missingSkills,
      seniorityMismatch,
    };
  }
}
