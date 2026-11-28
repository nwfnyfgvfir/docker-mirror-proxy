export interface Env {
  CACHE?: R2Bucket;
  IP_LIMIT: RateLimit;
  TOTAL_LIMIT: RateLimit;
  DOCKERHUB_USERNAME?: string;
  DOCKERHUB_PAT?: string;
}

const origins = {
  'docker.io': {
    registry: 'https://registry-1.docker.io',
    token: 'https://auth.docker.io/token',
    service: 'registry.docker.io',
  },
  'ghcr.io': {
    registry: 'https://ghcr.io',
    token: 'https://ghcr.io/token',
    service: 'ghcr.io',
  },
};

export interface Route {
  source: keyof typeof origins;
  repository: string;
  kind: 'manifests' | 'blobs';
  reference: string;
}

const component = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const tag = /^[\w][\w.-]{0,127}$/;
const digest = /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/;
export const sha256 = /^sha256:[a-f0-9]{64}$/;

export function parseRoute(path: string): Route | undefined {
  const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(path);
  if (!match) return;

  const parts = match[1].split('/');
  const first = parts[0];
  const source = first === 'ghcr.io' ? first : 'docker.io';
  if (first === 'ghcr.io' || first === 'docker.io') parts.shift();
  if (!parts.length || !parts.every(part => component.test(part))) return;
  if (parts.length === 1) {
    if (source === 'ghcr.io') return;
    parts.unshift('library');
  }

  const repository = parts.join('/');
  const kind = match[2] as Route['kind'];
  const reference = match[3];
  if (repository.length > 255 || (!digest.test(reference) && !(kind === 'manifests' && tag.test(reference)))) return;
  return { source, repository, kind, reference };
}

export function protocolHeaders(): Headers {
  return new Headers({ 'Docker-Distribution-API-Version': 'registry/2.0', 'Cache-Control': 'no-store' });
}

export function registryError(method: string, status: number, code: string, message: string, headers = protocolHeaders()): Response {
  headers.set('Content-Type', 'application/json');
  const body = method === 'HEAD' ? null : JSON.stringify({ errors: [{ code, message }] });
  return new Response(body, { status, headers });
}

export class OriginError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: string;

  constructor(status: number, code: string, message: string, retryAfter?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface Token {
  value: string;
  expires: number;
}

const tokensByEnvironment = new WeakMap<Env, Map<string, Token>>();

async function getToken(route: Route, env: Env, signal: AbortSignal, refresh: boolean): Promise<string> {
  let tokens = tokensByEnvironment.get(env);
  if (!tokens) {
    tokens = new Map();
    tokensByEnvironment.set(env, tokens);
  }

  const key = `${route.source}/${route.repository}`;
  const previous = tokens.get(key);
  if (!refresh && previous && previous.expires > Date.now()) return previous.value;

  const origin = origins[route.source];
  const url = new URL(origin.token);
  url.searchParams.set('service', origin.service);
  url.searchParams.set('scope', `repository:${route.repository}:pull`);
  const headers = new Headers({ Accept: 'application/json' });
  if (route.source === 'docker.io') {
    const { DOCKERHUB_USERNAME: user, DOCKERHUB_PAT: pat } = env;
    if (Boolean(user) !== Boolean(pat)) {
      throw new OriginError(503, 'UNAVAILABLE', 'Docker Hub upstream credentials are incomplete');
    }
    if (user && pat) headers.set('Authorization', `Basic ${btoa(`${user}:${pat}`)}`);
  }

  const response = await fetch(url, { headers, signal, cache: 'no-store', redirect: 'manual' });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw new OriginError(429, 'TOOMANYREQUESTS', 'upstream token endpoint is rate limited', response.headers.get('Retry-After') ?? undefined);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OriginError(403, 'DENIED', 'upstream did not authorize the pull');
    }
    throw new OriginError(502, 'UNAVAILABLE', 'upstream token request failed');
  }

  const data = await response.json<{ token?: string; access_token?: string; expires_in?: number }>();
  const value = data.token ?? data.access_token;
  if (typeof value !== 'string' || !value) throw new OriginError(502, 'UNAVAILABLE', 'upstream returned no pull token');
  const ttl = Math.min(data.expires_in ?? 60, 300) - 15;
  if (tokens.size >= 256) tokens.delete(tokens.keys().next().value!);
  tokens.set(key, { value, expires: Date.now() + ttl * 1000 });
  return value;
}

export async function requestOrigin(route: Route, request: Request, env: Env, resolveTag = false): Promise<Response> {
  const origin = origins[route.source];
  const url = new URL(`/v2/${route.repository}/${route.kind}/${route.reference}`, origin.registry);
  const options: RequestInit = { method: resolveTag ? 'HEAD' : request.method, signal: request.signal, redirect: 'manual', cache: 'no-store' };
  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  for (const name of resolveTag ? ['Accept'] : ['Accept', 'Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  headers.set('Authorization', `Bearer ${await getToken(route, env, request.signal, false)}`);
  let response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    await response.body?.cancel();
    headers.set('Authorization', `Bearer ${await getToken(route, env, request.signal, true)}`);
    response = await fetch(url, { ...options, headers });
  }

  let redirectUrl = url;
  for (let count = 0; [301, 302, 303, 307, 308].includes(response.status); count++) {
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (!location || route.kind !== 'blobs' || count >= 5) {
      throw new OriginError(502, 'UNAVAILABLE', 'unexpected upstream redirect');
    }
    const next = new URL(location, redirectUrl);
    if (next.protocol !== 'https:' || next.username || next.password) {
      throw new OriginError(502, 'UNAVAILABLE', 'invalid upstream redirect');
    }
    if (next.origin !== redirectUrl.origin) headers.delete('Authorization');
    redirectUrl = next;
    response = await fetch(redirectUrl, { ...options, headers });
  }
  return response;
}
