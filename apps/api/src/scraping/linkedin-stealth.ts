/**
 * linkedin-stealth.ts
 * ===================
 * LinkedIn-specific scraper built on top of stealth-browser.ts.
 * Features multi-page pagination, clean HTML entity decoding,
 * structured JSON-LD detail extraction (contractType, salary, datePosted).
 */

export {
  createStealthContext,
  ProxyRotator,
  jitter,
  blockUnnecessaryResources,
  simulateHumanMouse,
  persistCookies,
  isBotChallengePage,
} from './stealth-browser';

export type { ProxyConfig, StealthContextOptions, FingerprintProfile } from './stealth-browser';

import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  createStealthContext,
  blockUnnecessaryResources,
  simulateHumanMouse,
  persistCookies,
  isBotChallengePage,
  jitter,
  mapWithConcurrency,
} from './stealth-browser';
import type { ProxyConfig } from './stealth-browser';

export interface LinkedInSearchParams {
  keywords: string;
  location?: string;
  /** LinkedIn date-posted token: r86400=24h, r604800=7d, r2592000=30d */
  datePosted?: 'r86400' | 'r604800' | 'r2592000';
  proxy?: ProxyConfig;
  maxPages?: number;
}

export interface LinkedInOffer {
  externalId: string;
  title: string;
  company: string;
  location?: string;
  url: string;
  description: string;
  postedAt?: Date;
  salary?: string;
  contractType?: string;
}

const log = new Logger('LinkedInStealth');

export function cleanJobDescription(html: string): string {
  if (!html) return '';
  let text = html;
  if (text.includes('&lt;') || text.includes('&gt;') || text.includes('&amp;')) {
    text = cheerio.load(text).text();
  }
  const $ = cheerio.load(text);
  $('br').replaceWith('\n');
  $('p, div, h1, h2, h3, h4, li').each((_, elem) => {
    $(elem).append('\n');
  });
  return $.text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function mapEmploymentType(type?: string, titleAndDesc?: string): string | undefined {
  if (type === 'FULL_TIME') return 'CDI';
  if (type === 'CONTRACTOR') return 'Freelance';
  if (type === 'TEMPORARY') return 'CDD';
  if (type === 'INTERN') return 'Stage';
  if (titleAndDesc) {
    if (/\b(cdi)\b/i.test(titleAndDesc)) return 'CDI';
    if (/\b(cdd)\b/i.test(titleAndDesc)) return 'CDD';
    if (/\b(stage|internship)\b/i.test(titleAndDesc)) return 'Stage';
    if (/\b(alternance|apprentissage)\b/i.test(titleAndDesc)) return 'Alternance';
    if (/\b(freelance|indépendant)\b/i.test(titleAndDesc)) return 'Freelance';
  }
  return undefined;
}

/**
 * Scrapes LinkedIn public job listings using the stealth browser with multi-page pagination.
 */
export async function scrapeLinkedInWithStealth(params: LinkedInSearchParams): Promise<LinkedInOffer[]> {
  const { browser, context } = await createStealthContext({
    siteName: 'linkedin',
    proxy: params.proxy,
  });

  try {
    const page = await context.newPage();
    await blockUnnecessaryResources(context);

    // Warm-up: homepage visit sets cookies + session signals
    await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await jitter(1000, 2500);
    await simulateHumanMouse(page);

    const allOffers: LinkedInOffer[] = [];
    const seenIds = new Set<string>();

    // Paginate through start = 0, 10, 25 to collect 25-35 fresh listings
    const pageOffsets = [0, 10, 25];
    for (const start of pageOffsets) {
      const searchUrl = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
      searchUrl.searchParams.set('keywords', params.keywords);
      searchUrl.searchParams.set('location', params.location ?? 'France');
      searchUrl.searchParams.set('start', String(start));
      if (params.datePosted) searchUrl.searchParams.set('f_TPR', params.datePosted);

      await page.goto(searchUrl.toString(), { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      await jitter(500, 1200);

      if (await isBotChallengePage(page)) {
        log.warn('LinkedIn returned a challenge page — aborting and saving cookies');
        await persistCookies(context, 'linkedin');
        break;
      }

      const html = await page.content();
      const pageOffers = parseLinkedInJobCards(html);
      if (!pageOffers.length) break;

      for (const o of pageOffers) {
        if (!seenIds.has(o.externalId)) {
          seenIds.add(o.externalId);
          allOffers.push(o);
        }
      }

      if (allOffers.length >= 25) break;
    }

    log.log(`Collected ${allOffers.length} unique LinkedIn job cards, enriching details...`);

    // Enrich detail pages with concurrency limit
    const enriched = await mapWithConcurrency(allOffers, 3, async (offer) => {
      try {
        await jitter(500, 1500);
        const p = await context.newPage();
        await p.goto(offer.url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const detail: any = await (p as any).evaluate(`
          (() => {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            let rawDesc = '';
            let employmentType = '';
            let datePosted = '';
            let salaryText = '';

            for (const s of scripts) {
              try {
                const data = JSON.parse(s.textContent || '');
                const items = Array.isArray(data) ? data : [data];
                const jp = items.find(i => i && i['@type'] === 'JobPosting');
                if (jp) {
                  if (jp.description) rawDesc = jp.description;
                  if (jp.employmentType) employmentType = jp.employmentType;
                  if (jp.datePosted) datePosted = jp.datePosted;
                  if (jp.baseSalary) {
                    const val = jp.baseSalary.value;
                    const cur = jp.baseSalary.currency || '€';
                    if (typeof val === 'number') salaryText = val + ' ' + cur;
                    else if (val && (val.minValue || val.maxValue)) {
                      salaryText = (val.minValue || '') + ' - ' + (val.maxValue || '') + ' ' + cur;
                    }
                  }
                  break;
                }
              } catch(e) {}
            }

            if (!rawDesc) {
              const el = document.querySelector('.show-more-less-html__markup, .description__text, [data-test="job-description"]');
              rawDesc = el ? el.innerHTML : '';
            }

            return { rawDesc, employmentType, datePosted, salaryText };
          })()
        `);

        await p.close();

        const cleanDesc = cleanJobDescription(detail.rawDesc);
        const contractType = mapEmploymentType(detail.employmentType, `${offer.title} ${cleanDesc}`);

        return {
          ...offer,
          description: cleanDesc || offer.description,
          contractType: contractType || offer.contractType,
          salary: detail.salaryText || offer.salary,
          postedAt: detail.datePosted ? new Date(detail.datePosted) : offer.postedAt,
        };
      } catch {
        return offer;
      }
    });

    await persistCookies(context, 'linkedin');
    return enriched;
  } catch (e: any) {
    log.error(`LinkedIn stealth scraper error: ${e.message}`);
    return [];
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseLinkedInJobCards(html: string): LinkedInOffer[] {
  const $ = cheerio.load(html);
  const offers: LinkedInOffer[] = [];

  $('li').each((_, el) => {
    const card = $(el);
    const title = card.find('.base-search-card__title').text().trim();
    if (!title) return;

    const company = card.find('.base-search-card__subtitle').text().trim() || 'Entreprise non précisée';
    const location = card.find('.job-search-card__location').text().trim() || undefined;
    const rawLink = card.find('.base-card__full-link').attr('href') || '';
    const cleanUrl = rawLink.split('?')[0];
    const urn = card.find('[data-entity-urn]').attr('data-entity-urn') ?? '';
    const idMatch = urn.match(/jobPosting:(\d+)/) ?? cleanUrl.match(/-(\d+)$/) ?? cleanUrl.match(/\/view\/.*?(\d+)/);
    const externalId = idMatch ? idMatch[1] : `li-${offers.length}`;
    const dateStr = card.find('time').attr('datetime');
    const salary = card.find('.job-search-card__salary-info').text().trim().replace(/\s+/g, ' ') || undefined;

    const titleAndDesc = `${title} ${location || ''}`;
    const contractType = mapEmploymentType(undefined, titleAndDesc);

    offers.push({
      externalId,
      title,
      company,
      location,
      salary,
      contractType,
      description: `${title} chez ${company}${location ? ` — ${location}` : ''}`,
      url: cleanUrl || `https://www.linkedin.com/jobs/view/${externalId}`,
      postedAt: dateStr ? new Date(dateStr) : undefined,
    });
  });

  return offers;
}
