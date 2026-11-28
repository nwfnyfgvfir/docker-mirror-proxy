import bundledCatalog from './docker-hub-catalog.json' with { type: 'json' };
import { loadLiveDockerHubCatalog } from './hub-catalog.ts';
import { paginationQuery, parseRepository, parseRoute, protocolHeaders, registryError, requestOrigin } from './registry.ts';
import type { Env } from './registry.ts';

export const catalogPath = '/v2/_catalog';
export const searchPath = '/v1/search';
const defaultGhcrRepository = 'ghcr.io/astral-sh/uv';
const anonymousRegistryCredentials = Object.freeze({});
const manifestTypes = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

interface Catalog {
  repositories: readonly string[];
  source: 'configured' | 'live' | 'bundled';
  updatedAt?: number;
  nextPage?: number;
  upstream?: string;
}

const bundled: Catalog = {
  repositories: [...bundledCatalog.repositories, defaultGhcrRepository].sort(),
  source: 'bundled',
  updatedAt: Date.parse(bundledCatalog.updated_at),
};

function configuredRepositories(configured: string): string[] {
  const repositories = new Set<string>();
  for (const name of configured.split(',')) {
    const repo = parseRepository(name.trim());
    if (repo) repositories.add(repo.source === 'docker.io' ? repo.repository : `${repo.source}/${repo.repository}`);
  }
  return [...repositories].sort();
}

function localCatalog(configured?: string): Catalog {
  return configured ? { repositories: configuredRepositories(configured), source: 'configured' } : bundled;
}

async function getCatalog(request: Request, env: Env, firstPage: number): Promise<Catalog | undefined> {
  const configured = env.REGISTRY_CATALOG?.trim();
  if (configured) return localCatalog(configured);
  const live = await loadLiveDockerHubCatalog(request, env, firstPage);
  if (!live.repositories.length) return firstPage === 1 ? { ...bundled, upstream: live.upstream } : undefined;
  const repositories = firstPage === 1 ? [...live.repositories, defaultGhcrRepository].sort() : live.repositories;
  return { repositories, source: 'live', nextPage: live.nextPage, upstream: live.upstream };
}

async function upstreamSearch(request: Request, query: string, size: number, page: number): Promise<Response | undefined> {
  for (const origin of ['https://index.docker.io', 'https://registry.hub.docker.com']) {
    const upstream = new URL(searchPath, origin);
    upstream.search = new URLSearchParams({ q: query, n: String(size), page: String(page) }).toString();
    try {
      const response = await fetch(upstream, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(1800)]),
        redirect: 'manual',
        cache: 'no-store',
      });
      if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) return response;
      await response.body?.cancel();
    } catch {
      // Try the other Docker Hub index before searching the packaged catalog.
    }
  }
}

async function exactPublicRepository(request: Request, term: string): Promise<string | undefined> {
  if (!term.includes('/')) return;
  const match = /^([^@:]+)(?:[:@](.+))?$/.exec(term);
  if (!match) return;
  const [, name, reference] = match;
  const path = reference ? `manifests/${reference}` : 'tags/list';
  const route = parseRoute(`/v2/${name}/${path}`);
  if (!route) return;
  const url = new URL(request.url);
  url.search = '?n=1';
  try {
    const probe = new Request(url, {
      method: reference ? 'HEAD' : 'GET',
      headers: { Accept: reference ? manifestTypes : 'application/json' },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(2500)]),
    });
    const response = await requestOrigin(route, probe, anonymousRegistryCredentials);
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    if (!reference) {
      const tags = await response.json<{ tags?: string[] }>();
      if (!tags.tags?.length) return;
    }
    return route.source === 'docker.io' ? route.repository : `${route.source}/${route.repository}`;
  } catch {
    // Keyword search can still succeed when the registry probe is unavailable.
  }
}

async function searchRepositoryNames(request: Request, term: string): Promise<string[] | undefined> {
  const exact = await exactPublicRepository(request, term);
  if (exact) return [exact];
  const response = await upstreamSearch(request, term, 100, 1);
  if (!response) return;
  try {
    const data = await response.json<{ results: { name?: string }[] }>();
    return data.results.flatMap(result => {
      const repo = typeof result.name === 'string' ? parseRepository(result.name) : undefined;
      return repo?.source === 'docker.io' ? [repo.repository] : [];
    });
  } catch {
    return;
  }
}

function setNextLink(headers: Headers, path: string, query: string): void {
  headers.set('Link', `<${path}?${query}>; rel="next"`);
}

export async function listRepositories(request: Request, url: URL, env: Env): Promise<Response> {
  const count = url.searchParams.get('n') || undefined;
  const size = count === undefined ? undefined : Number(count);
  if (count !== undefined && (!/^\d+$/.test(count) || !Number.isSafeInteger(size))) {
    return registryError(request.method, 400, 'PAGINATION_NUMBER_INVALID', 'n must be a non-negative integer');
  }
  const last = url.searchParams.get('last') ?? '';
  const term = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  if (term.length > 256) return registryError(request.method, 400, 'NAME_INVALID', 'search term is too long');
  const firstPage = Number(url.searchParams.get('page') || '1');
  if (firstPage < 1 || !Number.isSafeInteger(firstPage + 30)) {
    return registryError(request.method, 400, 'PAGINATION_NUMBER_INVALID', 'invalid upstream page');
  }
  const configured = env.REGISTRY_CATALOG?.trim();
  let snapshot: Catalog | undefined;
  if (term) {
    const results = !configured && size !== 0 ? await searchRepositoryNames(request, term) : undefined;
    if (results) snapshot = { repositories: [...new Set(results)].sort(), source: 'live' };
    else {
      const local = localCatalog(configured);
      snapshot = { ...local, repositories: local.repositories.filter(name => name.includes(term)) };
    }
  } else if (size === 0) {
    snapshot = localCatalog(configured);
  } else {
    snapshot = await getCatalog(request, env, firstPage);
  }
  if (!snapshot) return registryError(request.method, 502, 'UNAVAILABLE', 'upstream catalog page is unavailable');
  const repositories = snapshot.repositories.filter(name => name > last);
  const page = repositories.slice(0, size);
  const headers = protocolHeaders();
  headers.set('X-Docker-Mirror-Catalog', snapshot.source);
  if (snapshot.upstream) headers.set('X-Docker-Mirror-Catalog-Upstream', snapshot.upstream);
  if (snapshot.updatedAt) headers.set('Last-Modified', new Date(snapshot.updatedAt).toUTCString());
  if (page.length && page.length < repositories.length) {
    const query = new URLSearchParams({ n: String(size), last: page[page.length - 1] });
    if (term) query.set('q', term);
    if (!term && firstPage > 1) query.set('page', String(firstPage));
    setNextLink(headers, catalogPath, query.toString());
  } else if (page.length && snapshot.nextPage) {
    const query = new URLSearchParams({ page: String(snapshot.nextPage) });
    if (size !== undefined) query.set('n', String(size));
    setNextLink(headers, catalogPath, query.toString());
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Type', 'application/json');
    return new Response(null, { headers });
  }
  return Response.json({ repositories: page }, { headers });
}

export async function searchDockerHub(request: Request, url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const requestedSize = Number(url.searchParams.get('n') || '25');
  const size = Math.min(requestedSize, 100);
  const page = Number(url.searchParams.get('page') || '1');
  const offset = (page - 1) * size;
  if (query.length > 256 || !Number.isSafeInteger(requestedSize) || size < 1 || !Number.isSafeInteger(offset) || page < 1 || !Number.isSafeInteger(page)) {
    return registryError(request.method, 400, 'PAGINATION_NUMBER_INVALID', 'invalid search or page');
  }

  const headers = protocolHeaders();
  headers.set('Content-Type', 'application/json');
  if (request.method === 'HEAD') return new Response(null, { headers });

  if (query) {
    const exact = page === 1 ? await exactPublicRepository(request, query) : undefined;
    if (exact) {
      return Response.json({ query, page, page_size: size, num_pages: 1, num_results: 1, results: [searchEntry(exact)] }, { headers });
    }
    const upstream = await upstreamSearch(request, query, size, page);
    if (upstream) return new Response(upstream.body, { headers });
  }

  const term = query.toLowerCase();
  const configured = env.REGISTRY_CATALOG?.trim();
  const snapshot = query ? localCatalog(configured) : await getCatalog(request, env, 1) ?? localCatalog(configured);
  const matches = snapshot.repositories.filter(name => !name.startsWith('ghcr.io/') && name.includes(term));
  const results = matches.slice(offset, offset + size).map(searchEntry);
  return Response.json({ query, page, page_size: size, num_pages: Math.max(1, Math.ceil(matches.length / size)), num_results: matches.length, results }, { headers });
}

function searchEntry(repository: string) {
  const official = repository.startsWith('library/');
  return { name: official ? repository.slice('library/'.length) : repository, description: '', is_official: official, is_automated: false, star_count: 0 };
}

export async function listTags(request: Request, url: URL, origin: Response): Promise<Response> {
  const headers = protocolHeaders();
  const next = origin.headers.get('Link')?.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
  if (next && URL.canParse(next, url)) {
    const query = paginationQuery(new URL(next, url));
    if (query) setNextLink(headers, url.pathname, query);
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Type', 'application/json');
    return new Response(null, { headers });
  }

  const result = await origin.json<{ tags: string[] | null }>();
  // Return the repository name as requested, including its source when present.
  const name = url.pathname.slice('/v2/'.length, -'/tags/list'.length);
  return Response.json({ name, tags: result.tags ?? [] }, { headers });
}
