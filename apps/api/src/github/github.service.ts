import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface GithubRepoInfo {
  name: string;
  language: string | null;
  url: string;
  readmeExcerpt: string;
}

export interface GithubContext {
  text: string;
  repos: GithubRepoInfo[];
}

export interface GithubFullRepoInfo {
  externalId: string;
  name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  fork: boolean;
  private: boolean;
  url: string;
  pushedAt: string | null;
  readmeExcerpt: string;
}

const EMPTY_CONTEXT: GithubContext = { text: '', repos: [] };

// Plain .slice(0, n) can land in the middle of a surrogate pair (READMEs
// are full of emoji) and leave a lone/unpaired code unit at the cut, which
// DeepSeek's JSON parser then rejects the whole request body over
// ("unexpected end of hex escape") — trim the extra unit instead.
export function truncateSafely(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// Scaffold-generated READMEs (Laravel's default, Flutter's `flutter create`
// boilerplate, Create React App's, ...) describe the *framework*, not what
// the candidate actually built — confirmed live: several synced repos had
// nothing but this text as their "source of truth", which is worse than no
// README at all since it reads as real signal to the AI. Matched against a
// handful of well-known openers; anything else is assumed to be real content
// written by the repo's author.
const BOILERPLATE_README_MARKERS = [
  'is a web application framework with expressive, elegant syntax', // Laravel
  'this project is a starting point for a flutter application', // flutter create
  'this project was bootstrapped with create react app',
  'in the project directory, you can run', // CRA default body
  'getting started with create react app',
  'this is a next.js project bootstrapped with',
  'welcome to your expo app',
];

function isBoilerplateReadme(cleaned: string): boolean {
  const normalized = cleaned.toLowerCase();
  return BOILERPLATE_README_MARKERS.some((marker) => normalized.includes(marker));
}

export function cleanReadme(raw: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images/badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/^#+\s*/gm, '') // markdown headers
    .replace(/\s+/g, ' ')
    .trim();

  if (isBoilerplateReadme(cleaned)) return '';
  return truncateSafely(cleaned, 500);
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'findurjob-clone-personal-tool',
  };

  // Best-effort context for AI prompts — never blocks generation. Public
  // GitHub API, no auth needed, generous enough rate limit for personal use.
  async fetchContext(username?: string): Promise<GithubContext> {
    if (!username?.trim()) return EMPTY_CONTEXT;
    const user = username.trim();

    try {
      const response = await axios.get(`https://api.github.com/users/${user}/repos`, {
        params: { sort: 'updated', per_page: 10 },
        headers: this.headers,
        timeout: 5000,
      });

      const topRepos = (response.data || [])
        .filter((r: any) => !r.fork && !r.private)
        .sort((a: any, b: any) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
        .slice(0, 5);

      if (!topRepos.length) return EMPTY_CONTEXT;

      const readmes = await Promise.allSettled(topRepos.map((r: any) => this.fetchReadme(user, r.name)));

      const repos: GithubRepoInfo[] = topRepos.map((r: any, idx: number) => ({
        name: r.name,
        language: r.language || null,
        url: r.html_url,
        readmeExcerpt: readmes[idx].status === 'fulfilled' ? (readmes[idx] as PromiseFulfilledResult<string>).value : '',
      }));

      const lines = repos.map((r) => {
        const lang = r.language ? ` [${r.language}]` : '';
        const readme = r.readmeExcerpt ? ` — ${r.readmeExcerpt}` : ' — pas de README exploitable';
        return `- ${r.name}${lang}${readme}`;
      });

      return {
        text: `Dépôts GitHub publics récents du candidat (@${user}), avec extrait du README réel :\n${lines.join('\n')}`,
        repos,
      };
    } catch (error: any) {
      this.logger.warn(`GitHub context fetch failed for ${user}: ${error.message}`);
      return EMPTY_CONTEXT;
    }
  }

  private async fetchReadme(owner: string, repo: string, token?: string): Promise<string> {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: token ? { ...this.headers, Authorization: `Bearer ${token}` } : this.headers,
        timeout: 4000,
      });

      const content = Buffer.from(response.data.content, response.data.encoding).toString('utf-8');
      return cleanReadme(content);
    } catch {
      return '';
    }
  }

  // Full sync for the knowledge base — authenticated with a personal access
  // token so private repos are included, not just the public top-5 used for
  // the lightweight `fetchContext` above. Bounded to 10 pages (1000 repos)
  // as a safety net; a real account will exhaust relevance long before that.
  async listAllRepos(token: string): Promise<GithubFullRepoInfo[]> {
    const authHeaders = { ...this.headers, Authorization: `Bearer ${token}` };
    const repos: any[] = [];

    for (let page = 1; page <= 10; page++) {
      const response = await axios.get('https://api.github.com/user/repos', {
        params: { visibility: 'all', affiliation: 'owner', sort: 'updated', per_page: 100, page },
        headers: authHeaders,
        timeout: 8000,
      });
      const batch = response.data || [];
      repos.push(...batch);
      if (batch.length < 100) break;
    }

    const nonForks = repos.filter((r) => !r.fork);
    const readmes = await Promise.allSettled(
      nonForks.map((r) => this.fetchReadme(r.owner.login, r.name, token)),
    );

    return nonForks.map((r, idx) => ({
      externalId: String(r.id),
      name: r.name,
      description: r.description || null,
      language: r.language || null,
      topics: r.topics || [],
      stars: r.stargazers_count || 0,
      fork: r.fork,
      private: r.private,
      url: r.html_url,
      pushedAt: r.pushed_at || null,
      readmeExcerpt: readmes[idx].status === 'fulfilled' ? (readmes[idx] as PromiseFulfilledResult<string>).value : '',
    }));
  }
}
