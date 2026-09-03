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

const EMPTY_CONTEXT: GithubContext = { text: '', repos: [] };

// Plain .slice(0, n) can land in the middle of a surrogate pair (READMEs
// are full of emoji) and leave a lone/unpaired code unit at the cut, which
// DeepSeek's JSON parser then rejects the whole request body over
// ("unexpected end of hex escape") — trim the extra unit instead.
function truncateSafely(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function cleanReadme(raw: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images/badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/^#+\s*/gm, '') // markdown headers
    .replace(/\s+/g, ' ')
    .trim();
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

  private async fetchReadme(owner: string, repo: string): Promise<string> {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: this.headers,
        timeout: 4000,
      });

      const content = Buffer.from(response.data.content, response.data.encoding).toString('utf-8');
      return cleanReadme(content);
    } catch {
      return '';
    }
  }
}
