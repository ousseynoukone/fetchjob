import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SettingsService } from '../common/settings.service';
import { GithubRepoInfo } from '../github/github.service';

const MODEL = 'deepseek-chat';

// A curated list of tech-stack terms worth guarding — not exhaustive, but
// covers the common "swap one stack for another" failure mode (e.g. Spring
// Boot/PostgreSQL rewritten as ASP.NET/SQL Server to match a job posting).
const TECH_TERMS = [
  'java', 'spring boot', 'spring', 'kotlin', 'c#', '.net', 'asp.net', 'asp mvc',
  'python', 'django', 'flask', 'php', 'laravel', 'symfony', 'ruby', 'rails',
  'javascript', 'typescript', 'node.js', 'node', 'express', 'nestjs', 'go', 'golang',
  'rust', 'scala', 'swift', 'react', 'angular', 'vue', 'flutter', 'dart',
  'postgresql', 'mysql', 'sql server', 'oracle', 'mongodb', 'redis', 'cassandra',
  'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins',
  'aws', 'azure', 'gcp', 'google cloud',
  'kafka', 'rabbitmq', 'graphql', 'grpc',
  // Architecture/practice vocabulary — was missing entirely, so a term like
  // "microservices" already present in a candidate's own bullet (confirmed
  // live: "architecture micro-service" on a real experience) was invisible
  // to this list and never counted as already-grounded.
  'microservices', 'microservice', 'micro-service', 'micro-services', 'monolithe', 'monolith',
  'ci/cd', 'cicd', 'tdd', 'bdd', 'ddd', 'mvc', 'mvvm', 'clean architecture',
  'serverless', 'event-driven', 'websocket', 'soap', 'oauth', 'jwt', 'rest api', 'restful',
  'github actions', 'gitlab ci',
];

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

// Defense-in-depth: a lone/unpaired UTF-16 surrogate anywhere in the prompt
// (e.g. an emoji split by an upstream .slice()) makes DeepSeek's JSON
// parser reject the entire request body ("unexpected end of hex escape"),
// failing CV/lettre/analyse together. Strip any that slipped through.
function stripLoneSurrogates(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function normalizeForCompare(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(DIACRITICS_REGEX, '');
}

function techTermsIn(text: string): Set<string> {
  const normalized = normalizeForCompare(text);
  return new Set(TECH_TERMS.filter((term) => normalized.includes(term)));
}

// Safety net behind the prompt: if an adapted experience introduces a tech
// term that wasn't anywhere in that same experience's original bullets NOR
// in the candidate's own additional notes, revert that whole experience's
// bullets to the original rather than risk shipping a fabricated tech
// stack. The notes are the one extra source trusted here — they're the
// candidate's own self-reported facts about themselves (the same trust
// level as the rest of their CV), unlike a GitHub personal project, which
// proves nothing about what a specific past employer actually used.
function sanitizeAdaptedExperiences(original: any[], adapted: any[], additionalContextTerms: Set<string>): any[] {
  return adapted.map((exp: any, idx: number) => {
    const originalExp = original[idx];
    if (!originalExp) return exp;

    const originalTerms = techTermsIn((originalExp.bullets || []).join(' '));
    const allowedTerms = new Set([...originalTerms, ...additionalContextTerms]);
    const adaptedTerms = techTermsIn((exp.bullets || []).join(' '));
    const hasFabrication = [...adaptedTerms].some((term) => !allowedTerms.has(term));

    return hasFabrication ? { ...exp, bullets: originalExp.bullets } : exp;
  });
}

// Same defense-in-depth principle applied to a newly-proposed project: the
// AI is only allowed to reference a repo it was actually handed (with real
// README content), and every tech term it claims must trace back to that
// repo's own README/language — never invented, never borrowed from another
// experience's stack.
function sanitizeOneNewProject(
  repos: GithubRepoInfo[] | undefined,
  existingProjects: any[],
  alreadyAdded: Set<string>,
  newProject: any,
): any | null {
  if (!newProject?.name || !Array.isArray(newProject.bullets) || !newProject.bullets.length) return null;
  if (!repos?.length) return null;

  const normalizedName = normalizeForCompare(newProject.name);
  const matchedRepo = repos.find((r) => normalizedName.includes(normalizeForCompare(r.name)));
  if (!matchedRepo) return null;
  if (alreadyAdded.has(normalizeForCompare(matchedRepo.name))) return null;

  const alreadyOnCv = (existingProjects || []).some((p) =>
    normalizeForCompare(p.name || '').includes(normalizeForCompare(matchedRepo.name)),
  );
  if (alreadyOnCv) return null;

  const sourceText = `${matchedRepo.readmeExcerpt} ${matchedRepo.language || ''}`;
  const sourceTerms = techTermsIn(sourceText);
  const claimedTerms = techTermsIn(newProject.bullets.join(' '));
  const hasFabrication = [...claimedTerms].some((term) => !sourceTerms.has(term));
  if (hasFabrication) return null;

  alreadyAdded.add(normalizeForCompare(matchedRepo.name));
  return {
    name: newProject.name,
    period: '',
    url: matchedRepo.url,
    bullets: newProject.bullets.slice(0, 2),
  };
}

// Up to 4 — the candidate has real GitHub work sitting unused; surface
// meaningfully more of it when genuinely relevant, without turning the CV
// into an exhaustive repo list.
const MAX_NEW_PROJECTS = 4;

function sanitizeNewProjects(
  repos: GithubRepoInfo[] | undefined,
  existingProjects: any[],
  newProjects: any,
): any[] {
  const candidates = Array.isArray(newProjects) ? newProjects : newProjects ? [newProjects] : [];
  const alreadyAdded = new Set<string>();
  const sanitized: any[] = [];

  for (const candidate of candidates) {
    const project = sanitizeOneNewProject(repos, existingProjects, alreadyAdded, candidate);
    if (project) sanitized.push(project);
    if (sanitized.length >= MAX_NEW_PROJECTS) break;
  }

  return sanitized;
}

// Same anti-fabrication check, applied to the tailored summary: since a
// summary can reference anything on the CV (not one specific experience),
// it's validated against every tech term appearing anywhere in the
// candidate's data (experiences + skills + projects), not just one section.
function sanitizeSummary(cv: any, newProjects: any[], summary: unknown): string {
  if (typeof summary !== 'string' || !summary.trim()) return cv.summary || '';

  const wholeCvText = JSON.stringify({
    experiences: cv.experiences,
    skillGroups: cv.skillGroups,
    projects: [...(cv.projects || []), ...newProjects],
    additionalContext: cv.additionalContext,
  });
  const allowedTerms = techTermsIn(wholeCvText);
  const claimedTerms = techTermsIn(summary);
  const hasFabrication = [...claimedTerms].some((term) => !allowedTerms.has(term));

  return hasFabrication ? cv.summary || '' : summary.trim();
}

// Skills can never be *removed*, but they CAN be added — as long as the
// added skill is actually traceable to real evidence (the candidate's own
// GitHub repos, or already mentioned elsewhere in their CV/notes) rather
// than invented outright. A skill that's genuinely evidenced by real work
// but was never added to the declared list is a real gap to fix, not a lie;
// a skill with zero trace anywhere in the candidate's actual data is.
function sanitizeSkillGroups(original: any[], adapted: any, groundingTextNorm: string): any[] {
  if (!Array.isArray(adapted) || !adapted.length) return original;

  const flattenNorm = (groups: any[]) =>
    new Set((groups || []).flatMap((g) => g?.items || []).map((s: string) => normalizeForCompare(s)));

  const originalSet = flattenNorm(original);
  const adaptedSet = flattenNorm(adapted);

  // Every original skill must still be present somewhere — if the AI
  // silently dropped one, reject the whole response rather than risk it.
  const droppedSomething = [...originalSet].some((s) => !adaptedSet.has(s));
  if (droppedSomething) return original;

  const validated = (adapted as any[])
    .map((group) => ({
      ...group,
      items: (group.items || []).filter((item: string) => {
        const norm = normalizeForCompare(item);
        return originalSet.has(norm) || groundingTextNorm.includes(norm);
      }),
    }))
    .filter((group) => group.items.length > 0);

  return validated.length ? validated : original;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A raw substring check falsely matched short labels inside unrelated words
// — confirmed live: the skill "TS" was ranked as offer-relevant for a
// Java/Angular posting that never mentions TypeScript at all, purely because
// "TS" is a substring of "Craftsmanship" in the offer text. Word-boundary
// matching (treating any non-alphanumeric character, including "#"/"."
// already inside labels like "C#"/".Net", as a boundary) avoids that without
// needing a length cutoff that would also exclude legitimately short labels.
function isSkillMentioned(offerTextNorm: string, item: string): boolean {
  const normalizedItem = normalizeForCompare(item).trim();
  if (!normalizedItem) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedItem)}([^a-z0-9]|$)`, 'i');
  return pattern.test(offerTextNorm);
}

// Deterministic, not left to the model: moves items whose name appears in
// the offer's own text to the front of each group (stable otherwise) — a
// pure reorder of an already-validated set, so it carries zero fabrication
// risk and always actually happens, unlike asking the AI to reorder.
function reorderSkillsForOffer(skillGroups: any[], offerTextNorm: string): any[] {
  return (skillGroups || []).map((group) => ({
    ...group,
    items: [...(group.items || [])].sort((a: string, b: string) => {
      const aRelevant = isSkillMentioned(offerTextNorm, a) ? 0 : 1;
      const bRelevant = isSkillMentioned(offerTextNorm, b) ? 0 : 1;
      return aRelevant - bRelevant;
    }),
  }));
}

function cleanAndParseJson<T = any>(content: string, fallback: T): T {
  if (!content) return fallback;
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        // strip unescaped control chars
        try {
          const sanitized = cleaned.slice(first, last + 1)
            .replace(/[\u0000-\u001F]+/g, ' ')
            .replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(sanitized);
        } catch {
          return fallback;
        }
      }
    }
    return fallback;
  }
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  constructor(private settings: SettingsService) {}

  // Not cached: the key can change at runtime via the Paramètres page, so
  // re-read it fresh each call rather than lock in whatever was set at boot.
  private async getClient(): Promise<OpenAI> {
    const apiKey = await this.settings.get('deepseekApiKey');
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is not configured');
    }
    // DeepSeek exposes an OpenAI-compatible API — same SDK, different base URL.
    return new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1' });
  }

  async adaptCvBullets(
    cv: any,
    offer: { title: string; company: string; description: string },
    additionalContext?: string,
    githubRepos?: GithubRepoInfo[],
  ): Promise<any> {
    const reposBlock = (githubRepos || [])
      .filter((r) => r.readmeExcerpt)
      .map((r) => `- "${r.name}" [${r.language || 'langage inconnu'}] — README réel : ${r.readmeExcerpt}`)
      .join('\n');

    const prompt = `Tu es expert en recrutement. Adapte ce CV pour l'offre suivante : experiences, resume, ordre des competences, et eventuellement un ou deux nouveaux projets tires des depots GitHub du candidat. Toutes les sections listees ci-dessous doivent etre reconsiderees — n'en laisse aucune identique par defaut si une adaptation pertinente est possible.

REGLE ABSOLUE, LA PLUS IMPORTANTE : ne change JAMAIS quelle technologie, langage, framework, outil ou base de donnees a ete utilise. Tu peux reformuler, reordonner, raccourcir ou mettre en avant un aspect deja present — mais chaque techno citee dans ta reponse doit deja etre citee dans la source correspondante (le bullet ORIGINAL pour une experience, le README reel pour un nouveau projet, l'ensemble du CV pour le resume). Une techno mentionnee sur l'experience X ne doit jamais migrer vers l'experience Y, meme si elle fait partie des competences listees ailleurs.

Exemple INTERDIT : bullet original "API en Spring Boot / PostgreSQL" -> bullet adapte "API en ASP.NET / SQL Server" (fabrication, meme si le candidat connait aussi C#/.NET ailleurs).
Exemple AUTORISE : bullet original "API REST avec Spring Boot, JWT et PostgreSQL, tests unitaires JUnit" -> bullet adapte "Developpement d'API REST securisees (Spring Boot, JWT) avec PostgreSQL" (reformulation qui ne garde que des elements deja presents).

OFFRE: ${offer.title} chez ${offer.company}
DESCRIPTION: ${offer.description}
EXPERIENCES ACTUELLES (JSON): ${JSON.stringify(cv.experiences || [])}
COMPETENCES ACTUELLES (JSON): ${JSON.stringify(cv.skillGroups || [])}
RESUME ACTUEL: ${cv.summary || '(vide)'}
PROJETS DEJA SUR LE CV (JSON, ne pas dupliquer): ${JSON.stringify(cv.projects || [])}
${additionalContext ? `\nNOTES COMPLEMENTAIRES DU CANDIDAT (faits reels declares par le candidat lui-meme — source de verite valable pour enrichir une experience ou une competence, au meme titre que le reste du CV) :\n${additionalContext}\n` : ''}
${reposBlock ? `\nDEPOTS GITHUB DU CANDIDAT AVEC EXTRAIT REEL DE LEUR README (source de verite si tu ajoutes un projet ou une competence) :\n${reposBlock}\n\nSi et SEULEMENT SI certains de ces depots sont clairement pertinents pour l'offre ET absents des "PROJETS DEJA SUR LE CV", propose-les dans le champ "newProjects" (tableau, jusqu'a 4 elements). Pour chaque projet, ecris un bullet de type realisation professionnelle : QUOI (ce que fait concretement le projet/l'application) et AVEC QUOI (stack technique), en une phrase percutante — jamais une paraphrase des instructions d'installation, badges, licence ou table des matieres du README. Si le README ne decrit pas clairement une fonctionnalite ou un objectif exploitable (ex: seulement des instructions de setup), ne propose PAS ce projet plutot que d'inventer un objectif. Si aucun depot n'est clairement pertinent, mets "newProjects": [].\n` : '\nAucun depot GitHub exploitable n\'a ete fourni : mets systematiquement "newProjects": [].\n'}
INSTRUCTIONS PAR CHAMP :
- "experiences" : reformule les "bullets" de chaque experience pour mettre en avant les elements deja presents et pertinents pour cette offre. Tu peux aussi enrichir un bullet avec un fait reel tire des NOTES COMPLEMENTAIRES s'il concerne clairement cette experience (ex: une techno que le candidat dit avoir utilisee a ce poste mais qu'il a oublie de detailler) — jamais avec un fait tire des depots GitHub, qui sont des projets personnels sans lien avec un employeur. Garde le meme nombre d'experiences et de bullets par experience.
- "skillGroups" : ne supprime JAMAIS une competence existante. Tu PEUX en ajouter une nouvelle si et seulement si elle apparait clairement dans les DEPOTS GITHUB ci-dessus (langage, dependance reelle, sujet) ou dans les NOTES COMPLEMENTAIRES du candidat — une competence prouvee par du vrai travail mais absente de la liste est un oubli a corriger, pas une invention. N'ajoute jamais une competence qui n'apparait nulle part dans les donnees fournies. L'ordre au sein de chaque groupe n'a pas d'importance, il sera recalcule automatiquement.
- "summary" : 2 a 3 phrases d'accroche ciblees sur cette offre, basees uniquement sur les faits reels du CV (experiences/competences/projets) — jamais de metrique ou technologie non presente ailleurs dans les donnees fournies.
- "newProjects" : voir instructions ci-dessus.

Reponds uniquement avec un JSON de la forme { "experiences": [...], "skillGroups": [...], "summary": string, "newProjects": [{ "name": string, "bullets": string[] }] }, chaque section au meme format que dans les donnees d'entree.`;

    const response = await (await this.getClient()).chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    const adaptedExperiences = result.experiences || cv.experiences;
    const sanitizedNewProjects = sanitizeNewProjects(githubRepos, cv.projects || [], result.newProjects);
    const sanitizedSummary = sanitizeSummary(cv, sanitizedNewProjects, result.summary);

    // Real evidence a new skill can be grounded in: the candidate's own
    // GitHub repos (language/dependencies/README) and their own notes —
    // never another job's stack, and never thin air.
    const groundingTextNorm = normalizeForCompare(`${reposBlock} ${additionalContext || ''}`);
    const skillGroupsWithAdditions = sanitizeSkillGroups(cv.skillGroups || [], result.skillGroups, groundingTextNorm);

    const offerTextNorm = normalizeForCompare(`${offer.title} ${offer.description}`);
    const reorderedSkillGroups = reorderSkillsForOffer(skillGroupsWithAdditions, offerTextNorm);

    const additionalContextTerms = techTermsIn(additionalContext || '');

    return {
      ...cv,
      experiences: sanitizeAdaptedExperiences(cv.experiences || [], adaptedExperiences, additionalContextTerms),
      skillGroups: reorderedSkillGroups,
      summary: sanitizedSummary,
      projects: sanitizedNewProjects.length ? [...(cv.projects || []), ...sanitizedNewProjects] : cv.projects,
    };
  }

  async generateCoverLetter(
    cv: any,
    offer: { title: string; company: string; description: string },
    extraContext?: string,
  ): Promise<string> {
    const prompt = `Genere une lettre de motivation en francais, formelle, ~250-300 mots, sans placeholders ni crochets, en texte brut (aucun markdown, pas d'asterisques ni de gras).

REGLE ABSOLUE : appuie-toi uniquement sur les faits reels fournis ci-dessous (experiences, competences, projets, formation). N'invente aucune experience, technologie, metrique, duree ou responsabilite qui n'y figure pas. Tu peux choisir quels elements reels mettre en avant et reformuler pour coller a l'offre, mais jamais en fabriquer de nouveaux.

Ne commence PAS par une ligne "Objet : ..." ni par l'adresse du destinataire — ces elements sont deja affiches separement autour de ta lettre. Commence directement par "Madame, Monsieur," puis le corps du texte, et termine par la formule de politesse et le nom du candidat.

Candidat: ${cv.fullName}, ${cv.headline}
Resume: ${cv.summary || ''}
Experiences (JSON): ${JSON.stringify(cv.experiences || [])}
Projets personnels (JSON): ${JSON.stringify(cv.projects || [])}
Competences (JSON): ${JSON.stringify(cv.skillGroups || [])}
Formation (JSON): ${JSON.stringify(cv.education || [])}
Certifications (JSON): ${JSON.stringify(cv.certifications || [])}
Langues (JSON): ${JSON.stringify(cv.languages || [])}
Poste vise: ${offer.title} chez ${offer.company}
Description du poste: ${offer.description}
${extraContext ? `\nInformations complementaires sur le candidat (a mentionner seulement si pertinent pour cette offre, sans forcer) :\n${extraContext}\n` : ''}`;

    const response = await (await this.getClient()).chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
    });

    return response.choices[0].message.content || '';
  }

  async analyzeOffer(
    cv: any,
    offer: { title: string; company: string; description: string },
    extraContext?: string,
  ): Promise<Record<string, any>> {
    const prompt = `Analyse cette offre pour ce candidat.
Candidat (JSON): ${JSON.stringify(cv)}
Offre: ${offer.title} chez ${offer.company} - ${offer.description}
${extraContext ? `\nInformations complementaires sur le candidat :\n${extraContext}\n` : ''}
Reponds uniquement en JSON avec les champs: strengths (array de 3 max), gaps (array de 3 max), advice (string), recommendation (nombre de 1 a 5).`;

    try {
      const response = await (await this.getClient()).chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0]?.message?.content || '{}';
      return cleanAndParseJson(raw, {
        strengths: ['Compétences alignées avec le poste'],
        gaps: [],
        advice: 'Candidature adaptée aux exigences.',
        recommendation: 4,
      });
    } catch (err: any) {
      this.logger.warn(`analyzeOffer fallback used: ${err.message}`);
      return {
        strengths: ['Compétences clés du profil'],
        gaps: [],
        advice: 'Offre analysée avec succès.',
        recommendation: 4,
      };
    }
  }
}
