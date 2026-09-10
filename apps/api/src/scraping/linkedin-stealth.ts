/**
 * linkedin-stealth.ts
 * ===================
 * LinkedIn-specific scraper built on top of stealth-browser.ts.
 * Re-exports the shared stealth utilities so existing callers still work.
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

/**
 * Scrapes LinkedIn public job listings using the stealth browser.
 * No proxy required — fingerprint spoofing alone is highly effective.
 */
export async function scrapeLinkedInWithStealth(params: LinkedInSearchParams): Promise<LinkedInOffer[]> {
  const { browser, context } = await createStealthContext({
    siteName: 'linkedin',
    proxy: params.proxy,
  });

  try {
    const page = await context.newPage();
    await blockUnnecessaryResources(context);

    const searchUrl = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
    searchUrl.searchParams.set('keywords', params.keywords);
    searchUrl.searchParams.set('location', params.location ?? 'France');
    searchUrl.searchParams.set('start', '0');
    if (params.datePosted) searchUrl.searchParams.set('f_TPR', params.datePosted);

    // Warm-up: homepage visit sets cookies + session signals
    await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await jitter(1200, 3000);
    await simulateHumanMouse(page);

    await page.goto(searchUrl.toString(), { waitUntil: 'networkidle', timeout: 30000 });
    await jitter(500, 1500);

    if (await isBotChallengePage(page)) {
      log.warn('LinkedIn returned a challenge page — aborting and saving cookies');
      await persistCookies(context, 'linkedin');
      return [];
    }

    const offers = parseLinkedInJobCards(await page.content());
    log.log(`Parsed ${offers.length} LinkedIn job cards`);

    const enriched = await mapWithConcurrency(offers, 3, async (offer) => {
      try {
        await jitter(600, 2000);
        const p = await context.newPage();
        await p.goto(offer.url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Extract from JSON-LD (Google-indexed structured data — most reliable)
        const desc: string = await (p as any).evaluate(`
          (() => {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const s of scripts) {
              try {
                const data = JSON.parse(s.textContent || '');
                const items = Array.isArray(data) ? data : [data];
                const jp = items.find(i => i && i['@type'] === 'JobPosting');
                if (jp && jp.description) return jp.description.replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();
              } catch(e) {}
            }
            const el = document.querySelector('.show-more-less-html__markup,.description__text,[data-test="job-description"]');
            return el ? el.innerText.trim() : '';
          })()
        `);

        await p.close();
        return desc ? { ...offer, description: desc } : offer;
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

    const company = card.find('.base-search-card__subtitle').text().trim() || 'Entreprise non precis\u00e9e';
    const location = card.find('.job-search-card__location').text().trim() || undefined;
    const rawLink = card.find('.base-card__full-link').attr('href') || '';
    const cleanUrl = rawLink.split('?')[0];
    const urn = card.find('[data-entity-urn]').attr('data-entity-urn') ?? '';
    const idMatch = urn.match(/jobPosting:(\d+)/) ?? cleanUrl.match(/-(\d+)$/) ?? cleanUrl.match(/\/view\/.*?(\d+)/);
    const externalId = idMatch ? idMatch[1] : `li-${offers.length}`;
    const dateStr = card.find('time').attr('datetime');
    const salary = card.find('.job-search-card__salary-info').text().trim().replace(/\s+/g, ' ') || undefined;

    offers.push({
      externalId,
      title,
      company,
      location,
      salary,
      description: `${title} chez ${company}${location ? ` \u2014 ${location}` : ''}`,
      url: cleanUrl || `https://www.linkedin.com/jobs/view/${externalId}`,
      postedAt: dateStr ? new Date(dateStr) : undefined,
    });
  });

  return offers.slice(0, 20);
}
