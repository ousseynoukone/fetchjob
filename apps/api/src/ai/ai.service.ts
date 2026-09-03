import { Injectable } from '@nestjs/common';
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
// term that wasn't anywhere in that same experience's original bullets,
// revert that whole experience's bullets to the original rather than risk
// shipping a fabricated tech stack.
function sanitizeAdaptedExperiences(original: any[], adapted: any[]): any[] {
  return adapted.map((exp: any, idx: number) => {
    const originalExp = original[idx];
    if (!originalExp) return exp;

    const originalTerms = techTermsIn((originalExp.bullets || []).join(' '));
    const adaptedTerms = techTermsIn((exp.bullets || []).join(' '));
    const hasFabrication = [...adaptedTerms].some((term) => !originalTerms.has(term));

    return hasFabrication ? { ...exp, bullets: originalExp.bullets } : exp;
  });
}

// Same defense-in-depth principle applied to a newly-proposed project: the
// AI is only allowed to reference a repo it was actually handed (with real
// README content), and every tech term it claims must trace back to that
// repo's own README/language — never invented, never borrowed from another
// experience's stack.
function sanitizeNewProject(
  repos: GithubRepoInfo[] | undefined,
  existingProjects: any[],
  newProject: any,
): any | null {
  if (!newProject?.name || !Array.isArray(newProject.bullets) || !newProject.bullets.length) return null;
  if (!repos?.length) return null;

  const normalizedName = normalizeForCompare(newProject.name);
  const matchedRepo = repos.find((r) => normalizedName.includes(normalizeForCompare(r.name)));
  if (!matchedRepo) return null;

  const alreadyOnCv = (existingProjects || []).some((p) =>
    normalizeForCompare(p.name || '').includes(normalizeForCompare(matchedRepo.name)),
  );
  if (alreadyOnCv) return null;

  const sourceText = `${matchedRepo.readmeExcerpt} ${matchedRepo.language || ''}`;
  const sourceTerms = techTermsIn(sourceText);
  const claimedTerms = techTermsIn(newProject.bullets.join(' '));
  const hasFabrication = [...claimedTerms].some((term) => !sourceTerms.has(term));
  if (hasFabrication) return null;

  return {
    name: newProject.name,
    period: '',
    url: matchedRepo.url,
    bullets: newProject.bullets.slice(0, 2),
  };
}

@Injectable()
export class AiService {
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

    const prompt = `Tu es expert en recrutement. Adapte les bullet points d'experience de ce CV pour l'offre suivante.

REGLE ABSOLUE, LA PLUS IMPORTANTE : ne change JAMAIS quelle technologie, langage, framework, outil ou base de donnees a ete utilise sur une experience. Tu peux reformuler, reordonner, raccourcir ou mettre en avant un aspect deja present dans le bullet d'origine — mais chaque techno citee dans ta reponse doit deja etre citee dans le bullet ORIGINAL de cette meme experience. Ceci s'applique meme si une autre techno fait partie des competences du candidat listees ailleurs dans le CV : une techno mentionnee sur l'experience X ne doit jamais migrer vers l'experience Y.

Exemple INTERDIT : bullet original "API en Spring Boot / PostgreSQL" -> bullet adapte "API en ASP.NET / SQL Server" (fabrication, meme si le candidat connait aussi C#/.NET ailleurs).
Exemple AUTORISE : bullet original "API REST avec Spring Boot, JWT et PostgreSQL, tests unitaires JUnit" -> bullet adapte "Developpement d'API REST securisees (Spring Boot, JWT) avec PostgreSQL" (reformulation qui ne garde que des elements deja presents).

OFFRE: ${offer.title} chez ${offer.company}
DESCRIPTION: ${offer.description}
EXPERIENCES ACTUELLES (JSON): ${JSON.stringify(cv.experiences || [])}
PROJETS DEJA SUR LE CV (JSON, ne pas dupliquer): ${JSON.stringify(cv.projects || [])}
${additionalContext ? `\nNOTES COMPLEMENTAIRES DU CANDIDAT (a utiliser uniquement pour mieux formuler les bullets existants, jamais pour ajouter une technologie ou un projet qui n'est pas deja dans la liste ci-dessus) :\n${additionalContext}\n` : ''}
${reposBlock ? `\nDEPOTS GITHUB DU CANDIDAT AVEC EXTRAIT REEL DE LEUR README (source de verite si tu ajoutes un projet) :\n${reposBlock}\n\nSi et SEULEMENT SI un de ces depots est clairement pertinent pour l'offre ET absent des "PROJETS DEJA SUR LE CV", tu peux proposer AU PLUS UN nouveau projet a ajouter, dans le champ "newProject". Les bullets de ce nouveau projet doivent decrire UNIQUEMENT ce que dit le README fourni ci-dessus pour ce depot — n'invente aucune technologie, metrique ou fonctionnalite qui n'y figure pas explicitement. Si aucun depot n'est clairement pertinent, ou si le README ne donne pas assez d'information pour ecrire une description fiable, mets "newProject": null.\n` : '\nAucun depot GitHub exploitable n\'a ete fourni : mets systematiquement "newProject": null.\n'}
Reformule uniquement les "bullets" de chaque experience pour mettre en avant les elements deja presents et pertinents pour cette offre. Garde le meme nombre d'experiences et de bullets. Reponds uniquement avec un JSON de la forme { "experiences": [...], "newProject": { "name": string, "bullets": string[] } | null } au meme format que l'entree.`;

    const response = await (await this.getClient()).chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    const adaptedExperiences = result.experiences || cv.experiences;
    const sanitizedNewProject = sanitizeNewProject(githubRepos, cv.projects || [], result.newProject);

    return {
      ...cv,
      experiences: sanitizeAdaptedExperiences(cv.experiences || [], adaptedExperiences),
      projects: sanitizedNewProject ? [...(cv.projects || []), sanitizedNewProject] : cv.projects,
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

    const response = await (await this.getClient()).chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content || '{}');
  }
}
