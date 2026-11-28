import { paginationQuery, parseRepository, protocolHeaders, registryError } from './registry.ts';

export const catalogPath = '/v2/_catalog';
const defaultCatalog = 'library/alpine,ghcr.io/astral-sh/uv';

function setNextLink(headers: Headers, path: string, query: string): void {
  headers.set('Link', `<${path}?${query}>; rel="next"`);
}

export function listRepositories(request: Request, url: URL, catalog?: string): Response {
  const last = url.searchParams.get('last') ?? '';
  const repositories = new Set<string>();
  for (const name of (catalog?.trim() || defaultCatalog).split(',')) {
    const repo = parseRepository(name.trim());
    if (!repo) continue;
    const key = repo.source === 'docker.io' ? repo.repository : `${repo.source}/${repo.repository}`;
    if (key > last) repositories.add(key);
  }

  const count = url.searchParams.get('n');
  const size = count === null ? repositories.size : Number(count);
  if (count !== null && (!/^\d+$/.test(count) || !Number.isSafeInteger(size))) {
    return registryError(request.method, 400, 'PAGINATION_NUMBER_INVALID', 'n must be a non-negative integer');
  }

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
