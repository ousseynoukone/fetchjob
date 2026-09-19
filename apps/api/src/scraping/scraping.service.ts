import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
// patchright, not 'playwright' -- createStealthContext (stealth-browser.ts)
// now returns a patchright BrowserContext. The two packages' types are
// structurally near-identical but nominally distinct, so importing the
// wrong one here fails to typecheck even though the actual objects are
// fully compatible.
import { type BrowserContext } from 'patchright';
import {
  createStealthContext,
  blockUnnecessaryResources,
  simulateHumanMouse,
  persistCookies,
  isBotChallengePage,
  jitter,
  mapWithConcurrency as stealthMapWithConcurrency,
} from './stealth-browser';
import { SettingsService } from '../common/settings.service';
import { blockHeavyResources } from '../auto-apply/appliers/ats-common';
import { scrapeLinkedInWithStealth, ProxyRotator } from './linkedin-stealth';

// A plain axios GET, not a real browser -- there's no live Chromium engine
// here for this UA string to contradict via Client Hints the way the
// stealth-browser.ts/remote-login.service.ts fixes address, so a stale
// version here is a weaker signal on its own. Still bumped for general
// hygiene/consistency with the rest of the codebase's now-current numbers.
const DETAIL_PAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// A search-results card is the whole offer for some sources (LinkedIn,
// HelloWork) — no real description, just title/company/location stitched
// together. Both sites embed a full schema.org JobPosting on the detail
// page itself, so bounded-concurrency fan-out to fetch it is worth the
// extra requests. Indeed blocks plain HTTP outright (verified: 401) so it
// goes through Playwright like the search page already does.
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => HTML_ENTITIES[name]);
}

interface JsonLdJobPosting {
  description?: string;
  datePosted?: string;
}

// LinkedIn/HelloWork job-detail pages embed a schema.org JobPosting block
// for Google Jobs indexing — a stable, structured source for the full
// description, far more robust than guessing CSS class names that change
// with every redesign.
function extractJobPostingJsonLd(html: string): JsonLdJobPosting | null {
  const $ = cheerio.load(html);
  let result: JsonLdJobPosting | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const jobPosting = candidates.find((entry) => entry?.['@type'] === 'JobPosting');
      if (jobPosting?.description) {
        result = { description: jobPosting.description, datePosted: jobPosting.datePosted };
      }
    } catch {
      // Not parseable JSON-LD (or not a JobPosting) — skip this script tag.
    }
  });

  return result;
}

// Bounds the extra per-offer detail-page fan-out so a single search doesn't
// fire 20 simultaneous requests at a site and risk getting rate-limited.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ScrapedOffer {
  externalId: string;
  source: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  url: string;
  contractType?: string;
  salary?: string;
  postedAt?: Date;
}

export interface SearchParams {
  keywords: string;
  location?: string;
  contractTypes?: string[];
}

// France Travail's `region` param takes an INSEE region code, not a name.
// Covers the regions someone is actually likely to type into the location field.
const FRANCE_TRAVAIL_REGION_CODES: Record<string, string> = {
  'ile de france': '11',
  'auvergne rhone alpes': '84',
  'bourgogne franche comte': '27',
  'bretagne': '53',
  'centre val de loire': '24',
  'corse': '94',
  'grand est': '44',
  'hauts de france': '32',
  'normandie': '28',
  'nouvelle aquitaine': '75',
  'occitanie': '76',
  'pays de la loire': '52',
  'provence alpes cote d azur': '93',
};

// Welcome to the Jungle's own Algolia index uses its own English-leaning
// region spellings for the `office.state` facet, confirmed live by querying
// the index directly for its real facet values (not guessed) -- same
// normalized keys as FRANCE_TRAVAIL_REGION_CODES above so both are driven
// by the exact same campaign.location value, whatever region someone
// actually configures, not a single hardcoded case.
const WTTJ_REGION_NAMES: Record<string, string> = {
  'ile de france': 'Ile-de-France',
  'auvergne rhone alpes': 'Auvergne-Rhone-Alpes',
  'bourgogne franche comte': 'Bourgogne-Franche-Comte',
  'bretagne': 'Brittany',
  'centre val de loire': 'Centre-Val de Loire',
  'grand est': 'Grand Est',
  'hauts de france': 'Hauts-de-France',
  'normandie': 'Normandy',
  'nouvelle aquitaine': 'Nouvelle-Aquitaine',
  'occitanie': 'Occitanie',
  'pays de la loire': 'Loire Region',
  'provence alpes cote d azur': "Provence-Alpes-Cote d'Azur",
};

// APEC (Association Pour l'Emploi des Cadres) has no public/documented API,
// but its own Angular search app calls this JSON endpoint directly and it's
// confirmed live to work with a bare, unauthenticated POST -- no DataDome
// challenge on this specific path despite the site running DataDome
// elsewhere (a guessed detail-page endpoint DID get DataDome-blocked, so
// this fetcher deliberately never calls anything beyond this one confirmed
// path). `lieux` takes APEC's own internal numeric "lieuId" for a region,
// not the INSEE region code -- confirmed live for all 13 regions via APEC's
// own autocomplete endpoint (not guessed), same normalized keys as
// FRANCE_TRAVAIL_REGION_CODES/WTTJ_REGION_NAMES above so this is driven by
// whatever region the campaign actually has configured.
const APEC_SEARCH_URL = 'https://www.apec.fr/cms/webservices/rechercheOffre';
const APEC_REGION_LIEU_IDS: Record<string, string> = {
  'ile de france': '711',
  'auvergne rhone alpes': '20049',
  'bourgogne franche comte': '20071',
  'bretagne': '705',
  'centre val de loire': '20070',
  'corse': '20',
  'grand est': '20074',
  'hauts de france': '20073',
  'normandie': '20072',
  'nouvelle aquitaine': '20075',
  'occitanie': '20076',
  'pays de la loire': '717',
  'provence alpes cote d azur': '720',
};
// Confirmed live via APEC's own referentielstatique endpoint (RECHERCHE_OFFRE_TYPE_CONTRAT
// code list), not guessed. APEC is a cadre (professional/managerial) job
// board with no clean "Freelance" category in this taxonomy -- left
// unmapped rather than guessed, same reasoning as France Travail/Adzuna's
// own contract-type mappings above.
const APEC_CONTRACT_TYPE_CODES: Record<string, string> = {
  CDI: '101888',
  CDD: '101887',
  Alternance: '20053',
  Stage: '597171',
};

// Welcome to the Jungle's own frontend calls Algolia directly from the
// browser — this app-id/key pair ships in that public JS bundle to every
// visitor and is scoped to search-only (read) access, restricted to
// requests carrying WTTJ's own Referer/Origin. Same nature as the LinkedIn
// guest-jobs endpoint above: a public, unauthenticated, already-client-side
// API, not an extracted secret.
const WTTJ_ALGOLIA_URL = 'https://csekhvms53-dsn.algolia.net/1/indexes/*/queries';
const WTTJ_ALGOLIA_APP_ID = 'CSEKHVMS53';
const WTTJ_ALGOLIA_SEARCH_KEY = '4bd8f6215d0cc52b26430765769e65a0';
const WTTJ_JOBS_INDEX = 'wk_cms_jobs_production';

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeLocation(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .replace(/[-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cap on the cleaned description handed to the AI service. Real job ads
// don't need more than this to convey the role, and some detail pages leak
// nav/footer/related-jobs text into the JSON-LD description field.
const MAX_DESCRIPTION_LENGTH = 6000;

// Plain .slice(0, n) can land in the middle of a surrogate pair (an emoji,
// common in job ads) and leave a lone/unpaired code unit at the cut.
// DeepSeek's JSON parser then rejects the whole request body over it
// ("unexpected end of hex escape") — trim the extra unit instead.
function truncateSafely(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function stripHtml(html: string): string {
  // Decode first: some sources (LinkedIn's JSON-LD) escape their HTML, so
  // the tags below (<br>, </p>) only become visible after decoding.
  const decoded = decodeHtmlEntities(html);
  const cleaned = decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    // Stray control characters (bad source encoding, binary noise) blow up
    // to a 6-char \u00XX JSON escape each — keep only real whitespace.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateSafely(cleaned, MAX_DESCRIPTION_LENGTH);
}

const STOPWORDS = new Set(['pour', 'avec', 'dans', 'les', 'des', 'developpeur', 'developpeuse', 'and', 'the', 'for', 'with']);

// Arbeitnow/Jobicy/The Muse's free public APIs don't support real free-text
// search — they return a plain list. Filter locally by requiring at least
// one significant keyword token to appear in the title/description/tags,
// same "best-effort, don't over-filter" spirit as the IDF location check.
function matchesKeywords(haystack: string, keywords: string): boolean {
  const normalizedHaystack = normalizeLocation(haystack);
  const tokens = normalizeLocation(keywords)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  if (!tokens.length) return true;
  return tokens.some((token) => normalizedHaystack.includes(token));
}

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  /** Round-robin proxy pool from LINKEDIN_PROXIES env var (newline-separated URLs). */
  private readonly proxyRotator = ProxyRotator.fromEnv('LINKEDIN_PROXIES');

  constructor(private settings: SettingsService) {}

  async fetchOffers(source: string, params: SearchParams): Promise<ScrapedOffer[]> {
    try {
      switch (source) {
        case 'linkedin':
          return await this.fetchLinkedInOffers(params);
        case 'hellowork':
          return await this.fetchHelloWorkOffers(params);
        case 'indeed':
          return await this.fetchIndeedOffers(params);
        case 'france_travail':
          return await this.fetchFranceTravailOffers(params);
        case 'welcome_to_the_jungle':
          return await this.fetchWelcomeToTheJungleOffers(params);
        case 'adzuna':
          return await this.fetchAdzunaOffers(params);
        case 'apec':
          return await this.fetchApecOffers(params);
        case 'remotive':
          return await this.fetchRemotiveOffers(params);
        case 'arbeitnow':
          return await this.fetchArbeitnowOffers(params);
        case 'jobicy':
          return await this.fetchJobicyOffers(params);
        case 'the_muse':
          return await this.fetchTheMuseOffers(params);
        default:
          this.logger.warn(`Unsupported or unimplemented source: ${source}`);
          return [];
      }
    } catch (error: any) {
      const status = error.response?.status;
      this.logger.error(
        `Failed to fetch offers from ${source}: ${error.message}${status ? ` (HTTP ${status})` : ''}`,
      );
      return [];
    }
  }

  // Fetches the real job description from the offer's own detail page.
  // Only LinkedIn/HelloWork need this — their search-results cards never
  // carry real description text (see fetchLinkedInOffers/fetchHelloWorkOffers).
  // Indeed is enriched inline in fetchIndeedOffers (reusing its already-open
  // Playwright browser is far cheaper than launching a new one per offer),
  // and every other source already returns a full description from listing,
  // so this is a no-op passthrough for them.
  async enrichDescription(offer: ScrapedOffer): Promise<ScrapedOffer> {
    switch (offer.source) {
      case 'hellowork':
        return this.enrichHelloWorkDescription(offer);
      case 'linkedin':
        return this.enrichLinkedInDescription(offer);
      case 'welcome_to_the_jungle':
        return this.enrichWelcomeToTheJungleDescription(offer);
      default:
        return offer;
    }
  }

  private async enrichHelloWorkDescription(offer: ScrapedOffer): Promise<ScrapedOffer> {
    try {
      const response = await axios.get(offer.url, {
        headers: { 'User-Agent': DETAIL_PAGE_USER_AGENT, 'Accept-Language': 'fr-FR,fr;q=0.9' },
        timeout: 10000,
      });
      const jobPosting = extractJobPostingJsonLd(response.data);
      if (!jobPosting?.description) return offer;
      return {
        ...offer,
        description: stripHtml(jobPosting.description),
        postedAt: offer.postedAt || (jobPosting.datePosted ? new Date(jobPosting.datePosted) : undefined),
      };
    } catch (error: any) {
      this.logger.warn(`HelloWork detail fetch failed for ${offer.url}: ${error.message}`);
      return offer;
    }
  }

  private async enrichLinkedInDescription(offer: ScrapedOffer): Promise<ScrapedOffer> {
    // If the offer is already enriched by scrapeLinkedInWithStealth, keep it directly!
    if (offer.description && offer.description.length > 150) {
      return offer;
    }
    // Never use plain axios for LinkedIn (consistently blocked with 429/999)
    return offer;
  }

  // Welcome to the Jungle's job pages sit behind an AWS WAF challenge —
  // confirmed live: a plain GET gets back an empty 202 with
  // `x-amzn-waf-action: challenge`, no HTML at all. A real browser resolves
  // that challenge's JS on its own just by rendering the page (verified
  // live: the same URL loaded through Playwright comes back with the full
  // page, JobPosting JSON-LD included) — exactly the reason Indeed already
  // goes through Playwright above, not a CAPTCHA bypass of any kind.
  private async enrichWelcomeToTheJungleDescription(offer: ScrapedOffer): Promise<ScrapedOffer> {
    // Use stealth browser — WTTJ detail pages sit behind AWS WAF (confirmed: plain GET gets 202 + challenge)
    const { browser, context } = await createStealthContext({ siteName: 'wttj' });
    try {
      await blockUnnecessaryResources(context);
      const page = await context.newPage();
      await page.goto(offer.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Give WAF challenge JS + SPA hydration time to resolve
      await page.waitForTimeout(2500);
      const html = await page.content();
      const jobPosting = extractJobPostingJsonLd(html);
      if (!jobPosting?.description) return offer;
      return { ...offer, description: stripHtml(jobPosting.description) };
    } catch (error: any) {
      this.logger.warn(`Welcome to the Jungle detail fetch failed for ${offer.url}: ${error.message}`);
      return offer;
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  // LinkedIn Guest API — public endpoint returning HTML cards without requiring auth
  /**
   * Scrapes LinkedIn public job listings using the stealth browser.
   * Uses playwright-extra + stealth plugin to evade bot detection.
   * Rotates proxies from LINKEDIN_PROXIES env var when configured.
   */
  private async fetchLinkedInOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const proxy = this.proxyRotator.next();
    if (proxy) {
      this.logger.log(`LinkedIn scrape via proxy: ${proxy.server}`);
    }

    const stealthOffers = await scrapeLinkedInWithStealth({
      keywords: params.keywords,
      location: params.location,
      datePosted: 'r604800', // Last 7 days
      contractTypes: params.contractTypes,
      proxy,
    });

    return stealthOffers.map((o) => ({
      externalId: o.externalId,
      source: 'linkedin' as const,
      title: o.title,
      company: o.company,
      location: o.location,
      salary: o.salary,
      contractType: o.contractType,
      description: o.description,
      url: o.url,
      postedAt: o.postedAt,
    }));
  }

  // HelloWork — French recruitment platform HTML scraper
  // HelloWork — upgraded to stealth browser to bypass FriendlyCaptcha bot checks
  private async fetchHelloWorkOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const { browser, context } = await createStealthContext({ siteName: 'hellowork' });
    try {
      await blockUnnecessaryResources(context);
      const page = await context.newPage();

      // Warm-up on homepage (avoids FriendlyCaptcha cold-start triggers)
      await page.goto('https://www.hellowork.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await jitter(800, 2000);
      await simulateHumanMouse(page);

      const offers: ScrapedOffer[] = [];
      const seenIds = new Set<string>();

      // Confirmed live via direct curl comparison: HelloWork's `p` query
      // param (1-indexed) returns genuinely distinct job IDs per page --
      // every search before this only ever loaded page 1, silently capping
      // results at ~20-30 per query. 3 pages mirrors LinkedIn's own
      // pagination depth in this same file.
      const MAX_PAGES = 3;
      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const searchUrl = new URL('https://www.hellowork.com/fr-fr/emploi/recherche.html');
        searchUrl.searchParams.set('k', params.keywords);
        searchUrl.searchParams.set('l', params.location || 'France');
        searchUrl.searchParams.set('ray', '20');
        searchUrl.searchParams.set('p', String(pageNum));
        // Confirmed live via HelloWork's own filter form (inspected directly,
        // not guessed): its contract-type checkboxes are `c=CDI`/`c=CDD`/
        // `c=Stage`/`c=Alternance`/`c=Freelance` -- an exact match to the
        // campaign's own labels, repeatable for multiple values. Was never
        // sent before, so every search ran unscoped by contract type.
        for (const type of params.contractTypes || []) {
          searchUrl.searchParams.append('c', type);
        }

        await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await jitter(600, 1500);

        if (await isBotChallengePage(page)) {
          this.logger.warn('HelloWork returned a challenge page — aborting');
          break;
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const beforeCount = offers.length;

        $('a[data-cy="offerTitle"], a[href*="/emplois/"]').each((_, el) => {
          const a = $(el);
          const href = a.attr('href') || '';
          const idMatch = href.match(/\/emplois\/(\d+)\.html/);
          if (!idMatch) return;
          const externalId = idMatch[1];
          if (seenIds.has(externalId)) return;
          seenIds.add(externalId);

          const title = a.find('p.typo-l').text().trim() || a.attr('title')?.replace(/ - [^-]+$/, '') || a.text().trim();
          const company = a.find('p.typo-s').text().trim() || 'Entreprise non précisée';
          const card = a.closest('li, div.flex.flex-col, article');
          const location = card.find('[data-cy="localisationCard"]').first().text().trim() || undefined;
          const contractType = card.find('[data-cy="contractCard"]').first().text().trim() || undefined;
          let salary: string | undefined;
          card.find('.tag-secondary-s').each((_, sEl) => {
            const txt = $(sEl).text().trim().replace(/\s+/g, ' ');
            if (txt.includes('€') && !salary && txt.length < 50) salary = txt;
          });
          const workMode = card.find('[data-cy="contractTag"]').first().text().trim() || undefined;
          const descParts = [
            `${title} chez ${company}`,
            location ? `Localisation: ${location}` : '',
            contractType ? `Contrat: ${contractType}` : '',
            salary ? `Rémunération: ${salary}` : '',
            workMode ? `Modalité: ${workMode}` : '',
          ].filter(Boolean);

          offers.push({
            externalId,
            source: 'hellowork',
            title,
            company,
            location,
            contractType,
            salary,
            description: descParts.join(' | '),
            url: `https://www.hellowork.com${href}`,
          });
        });

        if (offers.length === beforeCount) break;
      }

      await persistCookies(context, 'hellowork');
      return offers;
    } catch (err: any) {
      this.logger.warn(`HelloWork stealth scraper error: ${err.message}`);
      return [];
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  // Indeed — Scraper with Playwright headless browser + Cheerio parsing
  // Indeed uses Playwright — now with stealth fingerprinting to bypass bot detection
  private async fetchIndeedOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const { browser, context } = await createStealthContext({ siteName: 'indeed' });
    try {
      await blockUnnecessaryResources(context);
      const page = await context.newPage();

      // Warm-up on homepage before search (avoids cold-start bot signals)
      await page.goto('https://fr.indeed.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await jitter(800, 2000);
      await simulateHumanMouse(page);

      // Indeed's own `jt` param -- same ambiguity as LinkedIn's f_JT (a
      // French CDD is still usually full-time hours, so Indeed's own
      // fulltime/contract/internship buckets can't cleanly separate CDI
      // from CDD either); same mapping approach for the same reason.
      const jtMap: Record<string, string> = { CDI: 'fulltime', CDD: 'fulltime', Freelance: 'contract', Stage: 'internship' };
      const jt = Array.from(new Set((params.contractTypes || []).map((t) => jtMap[t]).filter(Boolean))).join(',');

      const offers: ScrapedOffer[] = [];
      const seen = new Set<string>();

      // Indeed paginates via `start` (10 results/page) -- every search
      // before this only ever loaded start=0, silently capping results at
      // 20. Kept to 2 pages (vs. 3 elsewhere) since Indeed is already the
      // most bot-sensitive source in this file (Cloudflare) -- every extra
      // navigation is extra exposure, and isBotChallengePage below already
      // aborts the whole fetch the moment a challenge appears rather than
      // pushing through it.
      const MAX_PAGES = 2;
      for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
        const start = pageIdx * 10;
        const searchUrl = `https://fr.indeed.com/jobs?q=${encodeURIComponent(params.keywords)}&l=${encodeURIComponent(params.location || '')}&sort=date${jt ? `&jt=${jt}` : ''}${start ? `&start=${start}` : ''}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await jitter(500, 1500);

        if (await isBotChallengePage(page)) {
          this.logger.warn('Indeed returned a challenge page — aborting');
          await persistCookies(context, 'indeed');
          if (pageIdx === 0) return [];
          break;
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const beforeCount = offers.length;

        $('.job_seen_beacon, div.cardOutline, td.resultContent').each((_, cardEl) => {
          const card = $(cardEl);
          const linkEl = card.find('a[data-jk], a[id^="job_"], a[id^="sj_"]');
          const jk =
            linkEl.attr('data-jk') ||
            linkEl.attr('id')?.replace(/^(job_|sj_)/, '') ||
            card.closest('[data-jk]').attr('data-jk');
          if (!jk || seen.has(jk)) return;
          seen.add(jk);

          const titleEl = card.find('h2.jobTitle span, h3.jobTitle span, .jobTitle span, [data-testid="job-title"]').first();
          const title = titleEl.text().trim();
          if (!title) return;

          const company = card.find('[data-testid="company-name"], .companyName').first().text().trim() || 'Entreprise non précisée';
          const location = card.find('[data-testid="text-location"], .companyLocation').first().text().trim() || undefined;
          let snippet = card.find('.job-snippet, [data-testid="job-snippet"], ul').first().text().trim();
          snippet = snippet.replace(/\.mosaic[^{]+{[^}]+}/g, '').trim();
          const salary = card.find('[data-testid="attribute_snippet_testid"], .salary-snippet-container').first().text().trim() || undefined;

          offers.push({
            externalId: jk,
            source: 'indeed',
            title,
            company,
            location,
            description: snippet || `${title} chez ${company}${location ? ` (${location})` : ''}`,
            salary,
            url: `https://fr.indeed.com/viewjob?jk=${jk}`,
          });
        });

        if (offers.length === beforeCount) break;
      }

      const shortlisted = offers;
      const enriched = await stealthMapWithConcurrency(shortlisted, 3, (offer) =>
        this.fetchIndeedDescription(context, offer),
      );
      await persistCookies(context, 'indeed');
      return enriched;
    } catch (err: any) {
      this.logger.warn(`Indeed scraper error: ${err.message}`);
      return [];
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  private async fetchIndeedDescription(context: BrowserContext, offer: ScrapedOffer): Promise<ScrapedOffer> {
    const page = await context.newPage();
    try {
      await page.goto(`https://fr.indeed.com/viewjob?jk=${offer.externalId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      const html = await page.content();
      const jobPosting = extractJobPostingJsonLd(html);
      if (jobPosting?.description) {
        return { ...offer, description: stripHtml(jobPosting.description) };
      }

      const text = await page
        .locator('#jobDescriptionText')
        .first()
        .innerText()
        .catch(() => '');
      return text.trim() ? { ...offer, description: text.trim() } : offer;
    } catch (error: any) {
      this.logger.warn(`Indeed detail fetch failed for jk=${offer.externalId}: ${error.message}`);
      return offer;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async fetchFranceTravailToken(): Promise<string> {
    const clientId = await this.settings.get('franceTravailClientId');
    const clientSecret = await this.settings.get('franceTravailClientSecret');

    const response = await axios.post(
      'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'api_offresdemploiv2 o2dsoffre',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return response.data.access_token;
  }

  private async fetchFranceTravailOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const token = await this.fetchFranceTravailToken();

    // `commune` must be a 5-digit INSEE code, not a free-text city name; a
    // known region name maps to `region` instead. Otherwise the location
    // filter is silently dropped rather than sent as an invalid value.
    const rawLocation = params.location?.trim();
    let commune: string | undefined;
    let region: string | undefined;

    if (rawLocation && /^\d{5}$/.test(rawLocation)) {
      commune = rawLocation;
    } else if (rawLocation) {
      region = FRANCE_TRAVAIL_REGION_CODES[normalizeLocation(rawLocation)];
    }

    // Confirmed live: campaign.contractTypes was captured from the UI but
    // never actually sent to a single one of this project's sources --
    // every search ran completely unscoped by contract type regardless of
    // what was configured, forcing 100% reliance on a title-text exclude-
    // keyword match after the fact to catch stage/alternance offers (which
    // misses any that only mention it in the description, and wastes a
    // request "slot" on an offer that should never have come back at all).
    // France Travail's own API documents `typeContrat` with exact codes for
    // CDI/CDD (comma-separated for multiple) -- mapped only where the
    // match is exact and unambiguous. "Freelance" has no clean equivalent
    // here (this API is for employee contracts, not indépendant/portage
    // arrangements) and is deliberately left unmapped rather than guessed,
    // same for "Stage"/"Alternance" (France Travail models those via a
    // separate natureContrat/experienceExige facet, not typeContrat) --
    // guessing wrong here would risk silently excluding real CDI/CDD
    // offers, worse than today's behavior of not filtering at all.
    const typeContratMap: Record<string, string> = { CDI: 'CDI', CDD: 'CDD' };
    const typeContrat = (params.contractTypes || [])
      .map((t) => typeContratMap[t])
      .filter(Boolean)
      .join(',') || undefined;

    // Confirmed via France Travail's own API docs: `range` paginates as
    // "start-end" (max 149-wide window per call), and the response carries
    // a `Content-Range: offres <start>-<end>/<total>` header giving the real
    // total match count. Every call before this only ever sent the request
    // with NO range at all, silently defaulting to the API's own first-page
    // behavior (~20 results) regardless of how many hundreds or thousands
    // actually matched -- confirmed the single largest volume bottleneck
    // across all sources, official APIs included. Capped at 4 pages (200
    // offers) per keyword query as a runtime/budget bound, not a real API
    // limit -- still a 10x increase over the previous hard ceiling of 20.
    const PAGE_SIZE = 50;
    const MAX_PAGES = 4;
    const allResults: any[] = [];
    let total: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;

      const response = await axios.get(
        'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search',
        {
          headers: { Authorization: `Bearer ${token}`, Range: `offres ${start}-${end}` },
          params: {
            motsCles: params.keywords,
            commune,
            region,
            typeContrat,
            range: `${start}-${end}`,
          },
          validateStatus: (status) => status === 200 || status === 206 || status === 416,
        },
      );

      if (response.status === 416) break;

      const pageResults = response.data?.resultats || [];
      allResults.push(...pageResults);

      const contentRange = response.headers?.['content-range'] as string | undefined;
      const totalMatch = contentRange?.match(/\/(\d+)$/);
      if (totalMatch) total = Number(totalMatch[1]);

      if (pageResults.length < PAGE_SIZE) break;
      if (total !== undefined && allResults.length >= total) break;
    }

    return allResults.map((offer: any) => ({
      externalId: offer.id,
      source: 'france_travail',
      title: offer.intitule,
      company: offer.entreprise?.nom || 'Entreprise non précisée',
      location: offer.lieuTravail?.libelle,
      description: offer.description || '',
      url: offer.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/recherche/detail/${offer.id}`,
      contractType: offer.typeContrat,
      salary: offer.salaire?.libelle,
      postedAt: offer.dateCreation ? new Date(offer.dateCreation) : undefined,
    }));
  }

  // Welcome to the Jungle — same Algolia index its own search page queries,
  // called directly rather than scraping the (WAF-challenged, JS-rendered)
  // search results page. `office`/`remote`/`contract_type_names` are already
  // structured fields on the hit; the full description only exists on the
  // job's own page, fetched later via enrichDescription.
  private async fetchWelcomeToTheJungleOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    // Confirmed live by querying this exact Algolia index directly for its
    // real facet values (not guessed): this request never carried a
    // location or contract-type filter at all before, so every WTTJ search
    // ran completely nationwide and unscoped by contract type regardless of
    // what the campaign configured -- both are driven by whatever the
    // campaign actually has set, same as the mapping above, not a
    // hardcoded region.
    const filterClauses: string[] = [];
    const wttjRegion = params.location ? WTTJ_REGION_NAMES[normalizeLocation(params.location)] : undefined;
    if (wttjRegion) filterClauses.push(`office.state:"${wttjRegion}"`);

    const contractTypeMap: Record<string, string> = {
      CDI: 'FULL_TIME',
      CDD: 'TEMPORARY',
      Freelance: 'FREELANCE',
      Stage: 'INTERNSHIP',
      Alternance: 'APPRENTICESHIP',
    };
    const wttjContractTypes = (params.contractTypes || []).map((t) => contractTypeMap[t]).filter(Boolean);
    if (wttjContractTypes.length) {
      filterClauses.push(`(${wttjContractTypes.map((t) => `contract_type:${t}`).join(' OR ')})`);
    }

    // Algolia paginates via `page` (0-indexed), not an offset -- every call
    // before this hardcoded page 0 with hitsPerPage 20, silently capping
    // every query at 20 hits regardless of `nbHits` (the real total Algolia
    // reports). Fetched sequentially, same end-of-results/page-count bound
    // as the other two official-API sources above.
    const HITS_PER_PAGE = 20;
    const MAX_PAGES = 4;
    const allHits: any[] = [];
    let nbPages: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const algoliaParams = new URLSearchParams({
        hitsPerPage: String(HITS_PER_PAGE),
        page: String(page),
        query: params.keywords,
      });
      if (filterClauses.length) algoliaParams.set('filters', filterClauses.join(' AND '));

      const response = await axios.post(
        WTTJ_ALGOLIA_URL,
        {
          requests: [
            {
              indexName: WTTJ_JOBS_INDEX,
              params: algoliaParams.toString(),
            },
          ],
        },
        {
          headers: {
            'x-algolia-application-id': WTTJ_ALGOLIA_APP_ID,
            'x-algolia-api-key': WTTJ_ALGOLIA_SEARCH_KEY,
            'Content-Type': 'application/json',
            Referer: 'https://www.welcometothejungle.com/',
            Origin: 'https://www.welcometothejungle.com',
          },
          timeout: 10000,
        },
      );

      const result = response.data?.results?.[0];
      const hits: any[] = result?.hits || [];
      allHits.push(...hits);
      nbPages = result?.nbPages;

      if (!hits.length) break;
      if (nbPages !== undefined && page + 1 >= nbPages) break;
    }

    return allHits
      .filter((hit) => hit.organization?.slug && hit.slug)
      .map((hit) => {
        const city = hit.office?.city;
        const state = hit.office?.state;
        const location = city
          ? [city, state].filter(Boolean).join(', ')
          : hit.remote && hit.remote !== 'no'
            ? 'Télétravail'
            : undefined;

        return {
          externalId: hit.objectID,
          source: 'welcome_to_the_jungle',
          title: decodeHtmlEntities(hit.name || ''),
          company: hit.organization?.name || 'Entreprise non précisée',
          location,
          contractType: hit.contract_type_names?.fr || hit.contract_type || undefined,
          salary: hit.salary_yearly_minimum ? `${Math.round(hit.salary_yearly_minimum)}€+` : undefined,
          description: stripHtml(hit.profile || hit.name || ''),
          url: `https://www.welcometothejungle.com/fr/companies/${hit.organization.slug}/jobs/${hit.slug}`,
          postedAt: hit.published_at ? new Date(hit.published_at) : undefined,
        };
      });
  }

  private async fetchAdzunaOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const appId = await this.settings.get('adzunaAppId');
    const appKey = await this.settings.get('adzunaApiKey');

    // Adzuna's own contract-type facets are boolean flags (permanent/
    // contract), not a French CDI/CDD/Freelance enum -- CDI maps cleanly to
    // "permanent", CDD to "contract" (its closest fixed-term equivalent).
    // "Freelance"/"Stage"/"Alternance" have no reliable equivalent in
    // Adzuna's own taxonomy and are deliberately left unset rather than
    // guessed at, same reasoning as France Travail's mapping just above.
    const types = new Set(params.contractTypes || []);
    const contractParams: Record<string, number> = {};
    if (types.has('CDI')) contractParams.permanent = 1;
    if (types.has('CDD')) contractParams.contract = 1;

    // Adzuna paginates via the page number baked into the URL path itself
    // (/search/1, /search/2, ...), not a query param -- every call before
    // this hardcoded /search/1 and results_per_page:20, silently capping
    // every query at 20 results regardless of how many actually matched.
    // Fetched sequentially (Adzuna's docs ask for no concurrent paging) and
    // stopped as soon as a page comes back short, same end-of-results
    // signal as France Travail's pagination just above.
    const RESULTS_PER_PAGE = 50;
    const MAX_PAGES = 4;
    const allResults: any[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await axios.get(`https://api.adzuna.com/v1/api/jobs/fr/search/${page}`, {
        params: {
          app_id: appId,
          app_key: appKey,
          what: params.keywords,
          where: params.location,
          results_per_page: RESULTS_PER_PAGE,
          ...contractParams,
        },
      });

      const pageResults = response.data?.results || [];
      allResults.push(...pageResults);
      if (pageResults.length < RESULTS_PER_PAGE) break;
    }

    return allResults.map((offer: any) => ({
      externalId: String(offer.id),
      source: 'adzuna',
      title: offer.title,
      company: offer.company?.display_name || 'Entreprise non précisée',
      location: offer.location?.display_name,
      description: offer.description || '',
      url: offer.redirect_url,
      contractType: offer.contract_type,
      salary: offer.salary_min ? `${Math.round(offer.salary_min)}€ - ${Math.round(offer.salary_max || offer.salary_min)}€` : undefined,
      postedAt: offer.created ? new Date(offer.created) : undefined,
    }));
  }

  private async fetchApecOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const lieuId = params.location ? APEC_REGION_LIEU_IDS[normalizeLocation(params.location)] : undefined;
    const typesContrat = (params.contractTypes || []).map((t) => APEC_CONTRACT_TYPE_CODES[t]).filter(Boolean);

    const RANGE = 50;
    const MAX_PAGES = 4;
    const allResults: any[] = [];
    let total: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const startIndex = page * RANGE;
      const response = await axios.post(
        APEC_SEARCH_URL,
        {
          lieux: lieuId ? [lieuId] : [],
          fonctions: [],
          statutPoste: [],
          typesContrat,
          typesConvention: [],
          niveauxExperience: [],
          idsEtablissement: [],
          secteursActivite: [],
          typesTeletravail: [],
          idNomZonesDeplacement: [],
          positionNumbersExcluded: [],
          typeClient: 'CADRE',
          sorts: [{ type: 'SCORE', direction: 'DESCENDING' }],
          pagination: { range: RANGE, startIndex },
          activeFiltre: true,
          pointGeolocDeReference: { distance: 0 },
          motsCles: params.keywords,
        },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 },
      );

      const pageResults = response.data?.resultats || [];
      allResults.push(...pageResults);
      total = response.data?.totalCount;

      if (pageResults.length < RANGE) break;
      if (total !== undefined && allResults.length >= total) break;
    }

    return allResults.map((offer: any) => ({
      externalId: String(offer.id),
      source: 'apec',
      title: offer.intitule,
      company: offer.nomCommercial || 'Entreprise non précisée',
      location: offer.lieuTexte,
      // The list endpoint's own `texteOffre` is already a truncated snippet,
      // not the full description -- a full per-offer detail fetch would
      // need its own confirmed endpoint, and a guessed one during
      // reconnaissance got DataDome-blocked immediately, so this
      // deliberately stays snippet-only rather than risk that again.
      description: offer.texteOffre || offer.intitule,
      url: `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${offer.numeroOffre}`,
      salary: offer.salaireTexte || undefined,
      postedAt: offer.datePublication ? new Date(offer.datePublication) : undefined,
    }));
  }

  private async fetchRemotiveOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const response = await axios.get('https://remotive.com/api/remote-jobs', {
      params: { search: params.keywords },
    });

    const offers = (response.data?.jobs || []).slice(0, 20);

    return offers.map((offer: any) => ({
      externalId: String(offer.id),
      source: 'remotive',
      title: offer.title,
      company: offer.company_name || 'Entreprise non précisée',
      location: offer.candidate_required_location,
      description: stripHtml(offer.description || ''),
      url: offer.url,
      contractType: offer.job_type,
      salary: offer.salary || undefined,
      postedAt: offer.publication_date ? new Date(offer.publication_date) : undefined,
    }));
  }

  // Public, no-key job board API. No free-text search — fetch the recent
  // listing and filter locally against the campaign's keywords/location.
  private async fetchArbeitnowOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const response = await axios.get('https://www.arbeitnow.com/api/job-board-api');
    const offers = (response.data?.data || []) as any[];

    return offers
      .filter((offer) => {
        const haystack = `${offer.title} ${offer.description || ''} ${(offer.tags || []).join(' ')}`;
        const keywordMatch = matchesKeywords(haystack, params.keywords);
        const locationMatch = !params.location || offer.remote || matchesKeywords(offer.location || '', params.location);
        return keywordMatch && locationMatch;
      })
      .slice(0, 20)
      .map((offer) => ({
        externalId: offer.slug,
        source: 'arbeitnow',
        title: offer.title,
        company: offer.company_name || 'Entreprise non précisée',
        location: offer.location || (offer.remote ? 'Remote' : undefined),
        description: stripHtml(offer.description || ''),
        url: offer.url,
        contractType: (offer.job_types || [])[0],
        postedAt: offer.created_at ? new Date(offer.created_at * 1000) : undefined,
      }));
  }

  // Public, no-key remote-jobs API. `tag` filtering is fuzzy on their end,
  // so still re-check locally like Arbeitnow above.
  private async fetchJobicyOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const response = await axios.get('https://jobicy.com/api/v2/remote-jobs', {
      params: { count: 50 },
    });
    const offers = (response.data?.jobs || []) as any[];

    return offers
      .filter((offer) => {
        const haystack = `${offer.jobTitle} ${offer.jobExcerpt || ''} ${(offer.jobIndustry || []).join(' ')}`;
        return matchesKeywords(haystack, params.keywords);
      })
      .slice(0, 20)
      .map((offer) => ({
        externalId: String(offer.id),
        source: 'jobicy',
        title: offer.jobTitle,
        company: offer.companyName || 'Entreprise non précisée',
        location: offer.jobGeo || 'Remote',
        description: stripHtml(offer.jobExcerpt || offer.jobDescription || ''),
        url: offer.url,
        contractType: (offer.jobType || [])[0],
        postedAt: offer.pubDate ? new Date(offer.pubDate) : undefined,
      }));
  }

  // Public, no-key jobs API. Supports a real `location` param (unlike the
  // two above), keywords are still filtered locally since there's no
  // free-text search param.
  private async fetchTheMuseOffers(params: SearchParams): Promise<ScrapedOffer[]> {
    const response = await axios.get('https://www.themuse.com/api/public/jobs', {
      params: { page: 0, location: params.location || undefined },
    });
    const offers = (response.data?.results || []) as any[];

    return offers
      .filter((offer) => matchesKeywords(`${offer.name} ${offer.contents || ''}`, params.keywords))
      .slice(0, 20)
      .map((offer) => ({
        externalId: String(offer.id),
        source: 'the_muse',
        title: offer.name,
        company: offer.company?.name || 'Entreprise non précisée',
        location: (offer.locations || []).map((l: any) => l.name).join(', '),
        description: stripHtml(offer.contents || ''),
        url: offer.refs?.landing_page,
        contractType: offer.type,
        postedAt: offer.publication_date ? new Date(offer.publication_date) : undefined,
      }));
  }
}
