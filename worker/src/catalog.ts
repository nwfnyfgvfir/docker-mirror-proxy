import { paginationQuery, parseRepository, protocolHeaders, registryError } from './registry.ts';

export const catalogPath = '/v2/_catalog';
const defaultCatalog = 'library/alpine,library/mysql,library/nginx,library/postgres,library/redis,library/ubuntu,ghcr.io/astral-sh/uv';
const hubPageSize = 100;
const hubOrigin = 'https://hub.docker.com';
const officialImagesTree = 'https://api.github.com/repos/docker-library/official-images/git/trees/master?recursive=1';

interface OfficialImagesTree {
  tree: { path: string; type: string }[];
}

interface HubSearchPage {
  results: { repo_name?: string }[];
}

async function fetchCatalogSource<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'docker-mirror-proxy' },
    signal,
    redirect: 'error',
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 600, '400-599': -1 } },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Catalog source returned ${response.status}`);
  }
  return response.json<T>();
}

async function hubCatalog(request: Request, repositories: Set<string>, last: string): Promise<void> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const official = async () => {
    const data = await fetchCatalogSource<OfficialImagesTree>(new URL(officialImagesTree), signal);
    for (const entry of data.tree) {
      if (entry.type === 'blob' && /^library\/[^/]+$/.test(entry.path)) addRepository(repositories, entry.path, last);
    }
  };
  const popular = async (page: number) => {
    const url = new URL('/v2/search/repositories/', hubOrigin);
    url.search = new URLSearchParams({ query: '*', page_size: String(hubPageSize), page: String(page) }).toString();
    const data = await fetchCatalogSource<HubSearchPage>(url, signal);
    for (const image of data.results) {
      if (typeof image.repo_name === 'string') addRepository(repositories, image.repo_name, last);
    }
  };
  const sources = await Promise.allSettled([official(), popular(1), popular(2)]);
  if (sources.some(source => source.status === 'rejected') && !request.signal.aborted) {
    console.warn('Some public Docker Hub catalog pages could not be loaded');
  }
}

function addRepository(repositories: Set<string>, name: string, last: string): void {
  const repo = parseRepository(name);
  if (!repo) return;
  const key = repo.source === 'docker.io' ? repo.repository : `${repo.source}/${repo.repository}`;
  if (key > last) repositories.add(key);
}

function setNextLink(headers: Headers, path: string, query: string): void {
  headers.set('Link', `<${path}?${query}>; rel="next"`);
}

export async function listRepositories(request: Request, url: URL, catalog?: string): Promise<Response> {
  const count = url.searchParams.get('n');
  const size = count === null ? undefined : Number(count);
  if (count !== null && (!/^\d+$/.test(count) || !Number.isSafeInteger(size))) {
    return registryError(request.method, 400, 'PAGINATION_NUMBER_INVALID', 'n must be a non-negative integer');
  }
  const last = url.searchParams.get('last') ?? '';
  const repositories = new Set<string>();
  const configured = catalog?.trim();
  for (const name of (configured || defaultCatalog).split(',')) {
    addRepository(repositories, name.trim(), last);
  }
  if (!configured && size !== 0) await hubCatalog(request, repositories, last);

  const page = [...repositories].sort().slice(0, size);
  const headers = protocolHeaders();
  if (page.length && page.length < repositories.size) {
    const query = new URLSearchParams({ n: String(size), last: page[page.length - 1] });
    setNextLink(headers, catalogPath, query.toString());
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Type', 'application/json');
    return new Response(null, { headers });
  }
  return Response.json({ repositories: page }, { headers });
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
