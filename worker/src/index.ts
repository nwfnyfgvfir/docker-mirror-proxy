import { cacheStream, readCache } from './cache.ts';
import { OriginError, parseRoute, protocolHeaders, registryError, requestOrigin, sha256 } from './registry.ts';
import type { Env } from './registry.ts';

const forwardedHeaders = [
  'Accept-Ranges', 'Content-Type', 'Content-Length', 'Content-Encoding', 'Content-Range',
  'Docker-Content-Digest', 'ETag', 'Last-Modified', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining',
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { method } = request;
    if (method !== 'GET' && method !== 'HEAD') {
      const headers = protocolHeaders();
      headers.set('Allow', 'GET, HEAD');
      return registryError(method, 405, 'UNSUPPORTED', 'only image pulls are supported', headers);
    }

    const path = new URL(request.url).pathname;
    const route = parseRoute(path);
    if (!route && path !== '/v2/') return registryError(method, 404, 'NAME_UNKNOWN', 'unknown registry path');

    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await env.IP_LIMIT.limit({ key: ip })).success || !(await env.TOTAL_LIMIT.limit({ key: 'registry' })).success) {
        const headers = protocolHeaders();
        headers.set('Retry-After', '10');
        return registryError(method, 429, 'TOOMANYREQUESTS', 'request limit exceeded', headers);
      }

      if (!route) {
        const headers = protocolHeaders();
        headers.set('Content-Type', 'application/json');
        return new Response(method === 'HEAD' ? null : '{}', { headers });
      }

      if (method === 'GET' && route.kind === 'manifests' && !route.reference.includes(':')) {
        const resolved = await requestOrigin(route, request, env, true);
        if (resolved.status === 429) {
          const headers = protocolHeaders();
          const retryAfter = resolved.headers.get('Retry-After');
          if (retryAfter) headers.set('Retry-After', retryAfter);
          return registryError(method, 429, 'TOOMANYREQUESTS', 'upstream is rate limited', headers);
        }
        const digest = resolved.headers.get('Docker-Content-Digest');
        if (resolved.ok && digest && sha256.test(digest)) route.reference = digest;
      }

      const cached = await readCache(env.CACHE, route, request).catch(() => {
        console.warn('R2 cache read failed', route.source, route.kind);
      });
      if (cached) return cached;

      const origin = await requestOrigin(route, request, env);
      if (origin.status === 401 || origin.status === 403) {
        await origin.body?.cancel();
        return registryError(method, 403, 'DENIED', 'upstream did not authorize the pull');
      }

      const headers = protocolHeaders();
      for (const name of forwardedHeaders) {
        const value = origin.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      if (origin.ok && sha256.test(route.reference)) {
        const digest = headers.get('Docker-Content-Digest');
        if (digest && digest !== route.reference) {
          await origin.body?.cancel();
          return registryError(method, 502, 'DIGEST_INVALID', 'upstream returned an unexpected digest');
        }
        headers.set('Docker-Content-Digest', route.reference);
        headers.set('ETag', `"${route.reference}"`);
      }
      if (origin.ok && route.kind === 'blobs' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/octet-stream');
      }

      // A Range request can be relayed without storing a partial object.
      const body = method === 'HEAD' ? null : request.headers.has('Range')
        ? origin.body
        : cacheStream(env.CACHE, route, origin, headers, ctx);
      return new Response(body, { status: origin.status, headers });
    } catch (error) {
      if (error instanceof OriginError) {
        const headers = protocolHeaders();
        if (error.retryAfter) headers.set('Retry-After', error.retryAfter);
        return registryError(method, error.status, error.code, error.message, headers);
      }
      console.warn('Registry request failed', route?.source ?? 'gateway');
      return registryError(method, 502, 'UNAVAILABLE', 'registry request failed');
    }
  },
} satisfies ExportedHandler<Env>;
