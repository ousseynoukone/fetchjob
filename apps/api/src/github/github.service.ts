import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface GithubRepoInfo {
  name: string;
  language: string | null;
  url: string;
  readmeExcerpt: string;
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
  // Real dependency names pulled from the repo's own manifest file — a much
  // more specific tech-stack signal than the single GitHub-detected
  // `language`, and available even when there's no README at all.
  dependencies: string[];
  // Repo-structure facts (Docker, CI/CD, automated tests present) inferred
  // from the file tree — meaningful signal for repos with a thin or
  // boilerplate README.
  structureSignals: string[];
  // Repo size in KB, as reported by GitHub — used downstream to help tell
  // a real project apart from an empty/near-empty scratch repo.
  sizeKb: number;
}

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

// Meta-tooling that shows up as a "dependency" but isn't a meaningful part
// of a tech stack description (linters, formatters, test runners already
// implied elsewhere, git hooks...).
const DEPENDENCY_NOISE = new Set([
  'eslint', 'prettier', 'typescript', 'jest', 'ts-node', 'nodemon', 'husky',
  'lint-staged', 'ts-jest', 'babel', '@babel/core', 'nodemon', 'cross-env',
]);

function cleanDependencyNames(names: string[]): string[] {
  const cleaned = names
    .filter((name) => name && !name.startsWith('@types/') && !DEPENDENCY_NOISE.has(name.toLowerCase()))
    .filter((name, idx, arr) => arr.indexOf(name) === idx);
  return cleaned.slice(0, 20);
}

function parsePackageJsonManifest(content: string): string[] {
  try {
    const pkg = JSON.parse(content);
    return cleanDependencyNames(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  } catch {
    return [];
  }
}

function parseComposerJsonManifest(content: string): string[] {
  try {
    const pkg = JSON.parse(content);
    const names = Object.keys({ ...pkg.require, ...pkg['require-dev'] }).filter(
      (name) => name !== 'php' && !name.startsWith('ext-'),
    );
    return cleanDependencyNames(names);
  } catch {
    return [];
  }
}

// No YAML parser dependency — pubspec.yaml's dependency lists are simple
// enough (`  package_name: ^1.2.3` under a `dependencies:`/`dev_dependencies:`
// section) that line-based parsing is reliable without one.
function parsePubspecYamlManifest(content: string): string[] {
  const names: string[] = [];
  let inDepsSection = false;
  for (const line of content.split('\n')) {
    if (/^(dependencies|dev_dependencies):\s*$/.test(line)) {
      inDepsSection = true;
      continue;
    }
    if (inDepsSection) {
      if (/^\S/.test(line)) { inDepsSection = false; continue; } // dedent = new top-level key
      const match = line.match(/^\s{2}([a-zA-Z0-9_]+):/);
      if (match && match[1] !== 'flutter' && match[1] !== 'sdk') names.push(match[1]);
    }
  }
  return cleanDependencyNames(names);
}

function parseRequirementsTxtManifest(content: string): string[] {
  const names = content
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
    .map((line) => line.split(/[=<>~!\[; ]/)[0].trim())
    .filter(Boolean);
  return cleanDependencyNames(names);
}

// Not a real XML/Groovy parser — good enough to pull dependency
// coordinates out of Maven's `<artifactId>` tags or Gradle's
// `group:artifact:version` string literals without adding a dependency.
function parsePomXmlManifest(content: string): string[] {
  const matches = [...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
  return cleanDependencyNames(matches);
}

function parseGradleManifest(content: string): string[] {
  const matches = [...content.matchAll(/['"]([a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+):[^'"]*['"]/g)].map((m) => m[1]);
  return cleanDependencyNames(matches);
}

const MANIFEST_FILES: { path: string; parse: (content: string) => string[] }[] = [
  { path: 'package.json', parse: parsePackageJsonManifest },
  { path: 'composer.json', parse: parseComposerJsonManifest },
  { path: 'pubspec.yaml', parse: parsePubspecYamlManifest },
  { path: 'requirements.txt', parse: parseRequirementsTxtManifest },
  { path: 'pom.xml', parse: parsePomXmlManifest },
  { path: 'build.gradle', parse: parseGradleManifest },
];

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'findurjob-clone-personal-tool',
  };

  // Tries each known manifest file in turn (a repo only ever has one kind)
  // and returns the first one found — real dependency names, not just the
  // single language GitHub detected.
  private async fetchDependencies(owner: string, repo: string, token: string): Promise<string[]> {
    for (const manifest of MANIFEST_FILES) {
      try {
        const response = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/contents/${manifest.path}`,
          { headers: { ...this.headers, Authorization: `Bearer ${token}` }, timeout: 4000 },
        );
        const content = Buffer.from(response.data.content, response.data.encoding).toString('utf-8');
        const deps = manifest.parse(content);
        if (deps.length) return deps;
      } catch {
        // File doesn't exist at repo root, or wasn't parseable — try the next one.
      }
    }
    return [];
  }

  // Cheap structural facts from the file tree, useful signal even when the
  // README is thin/boilerplate or missing entirely.
  private async fetchStructureSignals(owner: string, repo: string, defaultBranch: string, token: string): Promise<string[]> {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}`,
        { params: { recursive: 1 }, headers: { ...this.headers, Authorization: `Bearer ${token}` }, timeout: 6000 },
      );
      const paths: string[] = (response.data?.tree || []).slice(0, 3000).map((entry: any) => entry.path || '');

      const signals: string[] = [];
      if (paths.some((p) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(p))) signals.push('Docker');
      if (paths.some((p) => p.startsWith('.github/workflows/'))) signals.push('CI/CD (GitHub Actions)');
      if (paths.some((p) => /(^|\/)(test|tests|spec|__tests__)\//i.test(p) || /\.(test|spec)\.[jt]sx?$/i.test(p))) {
        signals.push('Tests automatisés');
      }
      if (paths.some((p) => /(^|\/)(k8s|kubernetes)\//i.test(p) || /\.ya?ml$/i.test(p) && p.includes('deployment'))) {
        signals.push('Kubernetes');
      }
      return signals;
    } catch {
      return [];
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
  // token so private repos are included too. Bounded to 10 pages (1000
  // repos) as a safety net; a real account will exhaust relevance long
  // before that.
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
    const [readmes, dependencies, structureSignals] = await Promise.all([
      Promise.allSettled(nonForks.map((r) => this.fetchReadme(r.owner.login, r.name, token))),
      Promise.allSettled(nonForks.map((r) => this.fetchDependencies(r.owner.login, r.name, token))),
      Promise.allSettled(
        nonForks.map((r) => this.fetchStructureSignals(r.owner.login, r.name, r.default_branch || 'main', token)),
      ),
    ]);

    const settled = <T>(results: PromiseSettledResult<T>[], idx: number, fallback: T): T =>
      results[idx].status === 'fulfilled' ? (results[idx] as PromiseFulfilledResult<T>).value : fallback;

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
      readmeExcerpt: settled(readmes, idx, ''),
      dependencies: settled(dependencies, idx, [] as string[]),
      structureSignals: settled(structureSignals, idx, [] as string[]),
      sizeKb: r.size || 0,
    }));
  }
}
