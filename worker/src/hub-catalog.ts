import { parseRepository } from './registry.ts';
import type { Env } from './registry.ts';

const hubOrigin = 'https://hub.docker.com';
const pageSize = 100;
const authenticatedPages = 30;
const anonymousPages = 2;

interface SearchPage {
  next?: string | null;
  results: { repo_name?: string; is_private?: boolean }[];
}

const tokenCache = new WeakMap<Env, { value: string; expires: number }>();

async function getCatalogToken(env: Env, signal: AbortSignal): Promise<string | undefined> {
  if (!env.DOCKERHUB_USERNAME || !env.DOCKERHUB_PAT) return;
  const cached = tokenCache.get(env);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const response = await fetch(`${hubOrigin}/v2/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: env.DOCKERHUB_USERNAME, secret: env.DOCKERHUB_PAT }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2200)]),
      cache: 'no-store',
      redirect: 'error',
    });
    if (response.ok) {
      const { access_token: token } = await response.json<{ access_token?: string }>();
      if (typeof token === 'string' && token) {
        tokenCache.set(env, { value: token, expires: Date.now() + 300000 });
        return token;
      }
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Public results remain available when Hub login fails.
  }
}

async function getPage(page: number, token: string | undefined, signal: AbortSignal): Promise<SearchPage | undefined> {
  const url = new URL('/v2/search/repositories/', hubOrigin);
  url.search = new URLSearchParams({ query: '*', page_size: String(pageSize), page: String(page) }).toString();
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await fetch(url, { headers, signal, cache: 'no-store', redirect: 'error' });
    if (response.ok) {
      const data = await response.json<SearchPage>();
      if (Array.isArray(data.results)) return data;
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Stop pagination on a failed request or deadline.
  }
}

export async function loadLiveDockerHubCatalog(request: Request, env: Env, firstPage: number): Promise<{
  repositories: string[];
  nextPage?: number;
} | undefined> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6500)]);
  let token = await getCatalogToken(env, signal);
  let first = await getPage(firstPage, token, signal);
  if (!first && token) {
    token = undefined;
    first = await getPage(firstPage, token, signal);
  }
  if (!first) return;

  const repositories = new Set<string>();
  const addPage = (page: SearchPage) => {
    for (const result of page.results) {
      if (result.is_private || typeof result.repo_name !== 'string') continue;
      const repo = parseRepository(result.repo_name);
      if (repo?.source === 'docker.io') repositories.add(repo.repository);
    }
  };
  addPage(first);
  const lastPage = token ? firstPage + authenticatedPages - 1 : Math.min(firstPage + anonymousPages - 1, anonymousPages);
  let next = first.next;
  let currentPage = firstPage;
  while (next && currentPage < lastPage) {
    const size = Math.min(5, lastPage - currentPage);
    const pages = await Promise.all(Array.from({ length: size }, (_, index) => getPage(currentPage + index + 1, token, signal)));
    for (const page of pages) {
      next = page?.next;
      if (!page) break;
      addPage(page);
      currentPage++;
      if (!next) break;
    }
  }

  const nextPage = token && next && currentPage === lastPage ? currentPage + 1 : undefined;
  return { repositories: [...repositories].sort(), nextPage };
}
