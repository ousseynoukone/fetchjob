import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { type BrowserContext } from 'playwright';
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

const DETAIL_PAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

      const searchUrl = new URL('https://www.hellowork.com/fr-fr/emploi/recherche.html');
      searchUrl.searchParams.set('k', params.keywords);
      searchUrl.searchParams.set('l', params.location || 'France');
      searchUrl.searchParams.set('ray', '20');

      await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
      await jitter(600, 1500);

      if (await isBotChallengePage(page)) {
        this.logger.warn('HelloWork returned a challenge page — aborting');
        await persistCookies(context, 'hellowork');
        return [];
      }

      const html = await page.content();
      const $ = cheerio.load(html);
      const offers: ScrapedOffer[] = [];
      const seenIds = new Set<string>();

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

      await persistCookies(context, 'hellowork');
      return offers.slice(0, 20);
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

      const searchUrl = `https://fr.indeed.com/jobs?q=${encodeURIComponent(params.keywords)}&l=${encodeURIComponent(params.location || '')}&sort=date`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await jitter(500, 1500);

      if (await isBotChallengePage(page)) {
        this.logger.warn('Indeed returned a challenge page — aborting');
        await persistCookies(context, 'indeed');
        return [];
      }

      const html = await page.content();
      const $ = cheerio.load(html);
      const offers: ScrapedOffer[] = [];
      const seen = new Set<string>();

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

      const shortlisted = offers.slice(0, 20);
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

    const response = await axios.get(
      'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          motsCles: params.keywords,
          commune,
          region,
        },
        validateStatus: (status) => status === 200 || status === 206,
      },
    );

    const offers = response.data?.resultats || [];

    return offers.map((offer: any) => ({
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
    const response = await axios.post(
      WTTJ_ALGOLIA_URL,
      {
        requests: [
          {
            indexName: WTTJ_JOBS_INDEX,
            params: `hitsPerPage=20&page=0&query=${encodeURIComponent(params.keywords)}`,
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

    const hits: any[] = response.data?.results?.[0]?.hits || [];

    return hits
      .filter((hit) => hit.organization?.slug && hit.slug)
      .slice(0, 20)
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

    const response = await axios.get('https://api.adzuna.com/v1/api/jobs/fr/search/1', {
      params: {
        app_id: appId,
        app_key: appKey,
        what: params.keywords,
        where: params.location,
        results_per_page: 20,
      },
    });

    const offers = response.data?.results || [];

    return offers.map((offer: any) => ({
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
