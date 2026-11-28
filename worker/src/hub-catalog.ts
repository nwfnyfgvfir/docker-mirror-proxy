import { parseRepository } from './registry.ts';
import type { Env } from './registry.ts';

const hubOrigin = 'https://hub.docker.com';
const registryIndexOrigin = 'https://registry.hub.docker.com';
const pageSize = 100;
const authenticatedPages = 30;
const anonymousPages = 2;

interface SearchPage {
  next?: string | null;
  results: { repo_name?: string; is_private?: boolean }[];
}

interface PageResult {
  data?: SearchPage;
  status: string;
}

function fetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'network-error';
  if (error.name === 'TimeoutError' || /timed?\s*out|deadline/i.test(error.message)) return 'timeout';
  if (/redirect/i.test(error.message)) return 'redirect-error';
  if (/cache/i.test(error.message)) return 'cache-option-error';
  if (/dns|resolve/i.test(error.message)) return 'dns-error';
  if (/tls|certificate/i.test(error.message)) return 'tls-error';
  if (/blocked|denied|prohibited|not allowed|disallowed|policy|egress|virtual service/i.test(error.message)) return 'egress-denied';
  return /^[a-z]+error$/i.test(error.name) ? error.name : 'network-error';
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

async function getPage(origin: string, page: number, token: string | undefined, signal: AbortSignal, ordering?: string): Promise<PageResult> {
  const url = new URL('/v2/search/repositories/', origin);
  url.search = new URLSearchParams({ query: '*', page_size: String(pageSize), page: String(page) }).toString();
  if (ordering) url.searchParams.set('ordering', ordering);
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
      cache: 'no-store',
      redirect: 'manual',
    });
    if (response.ok) {
      const data = await response.json<SearchPage>();
      if (Array.isArray(data.results)) return { data, status: String(response.status) };
      return { status: 'invalid-response' };
    } else {
      await response.body?.cancel();
      return { status: String(response.status) };
    }
  } catch (error) {
    return { status: fetchFailure(error) };
  }
}

export async function loadLiveDockerHubCatalog(request: Request, env: Env, firstPage: number): Promise<{
  repositories: string[];
  nextPage?: number;
  upstream: string;
}> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6500)]);
  let token = await getCatalogToken(env, signal);
  let origin = hubOrigin;
  let first = await getPage(origin, firstPage, token, signal);
  if (!first.data && token && (first.status === '401' || first.status === '403')) {
    token = undefined;
    first = await getPage(origin, firstPage, token, signal);
  }
  if (!first.data) {
    const failure = `hub.docker.com=${first.status}`;
    origin = registryIndexOrigin;
    token = undefined;
    first = await getPage(origin, firstPage, token, signal);
    if (!first.data) return { repositories: [], upstream: `${failure}, registry.hub.docker.com=${first.status}` };
  }

  const repositories = new Set<string>();
  const addPage = (page: SearchPage) => {
    for (const result of page.results) {
      if (result.is_private || typeof result.repo_name !== 'string') continue;
      const repo = parseRepository(result.repo_name);
      if (repo?.source === 'docker.io') repositories.add(repo.repository);
    }
  };
  addPage(first.data);
  const recent = firstPage === 1 ? getPage(origin, 1, token, signal, '-last_updated') : undefined;
  const lastPage = token ? firstPage + authenticatedPages - 1 : Math.min(firstPage + anonymousPages - 1, anonymousPages);
  let next = first.data.next;
  let currentPage = firstPage;
  while (next && currentPage < lastPage) {
    const size = Math.min(5, lastPage - currentPage);
    const pages = await Promise.all(Array.from({ length: size }, (_, index) => getPage(origin, currentPage + index + 1, token, signal)));
    for (const { data: page } of pages) {
      next = page?.next;
      if (!page) break;
      addPage(page);
      currentPage++;
      if (!next) break;
    }
  }

  const recentPage = await recent;
  if (recentPage?.data) addPage(recentPage.data);

  const nextPage = token && next && currentPage === lastPage ? currentPage + 1 : undefined;
  return { repositories: [...repositories].sort(), nextPage, upstream: new URL(origin).hostname };
}
