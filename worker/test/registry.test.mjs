import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.ts';

const blob = Buffer.from('compressed image layer');
const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [] }));
const indexType = 'application/vnd.oci.image.index.v1+json';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// Node does not have the Workers FixedLengthStream API. It is verified separately in Wrangler.
globalThis.FixedLengthStream = class extends TransformStream {
  constructor() { super(); }
};

function fixture() {
  const objects = new Map();
  const tasks = [];
  const header = { 'CF-Connecting-IP': '192.0.2.10' };
  const allow = { limit: async () => ({ success: true }) };
  const env = {
    IP_LIMIT: allow,
    TOTAL_LIMIT: allow,
    CACHE: {
      async put(key, stream, options) {
        const bytes = Buffer.from(await new Response(stream).arrayBuffer());
        assert.equal(digest(bytes), `sha256:${options.sha256}`);
        objects.set(key, { bytes, size: bytes.length, httpMetadata: options.httpMetadata });
      },
      async head(key) {
        return objects.get(key) ?? null;
      },
      async get(key, options) {
        const item = objects.get(key);
        if (!item) return null;
        const range = options?.range;
        const bytes = range ? item.bytes.subarray(range.offset, range.offset + range.length) : item.bytes;
        return { ...item, body: new Response(bytes).body };
      },
    },
  };
  return {
    env,
    objects,
    async request(path, init) {
      return worker.fetch(new Request(`https://mirror.example.com${path}`, { ...init, headers: { ...header, ...init?.headers } }), env, {
        waitUntil: promise => tasks.push(promise),
      });
    },
    async flush() { await Promise.all(tasks.splice(0)); },
  };
}

test('health, denied writes and rate limits are handled without upstream calls', async t => {
  const mirror = fixture();
  const origin = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected fetch'); });
  const ping = await mirror.request('/v2/');
  assert.equal(await ping.text(), '{}');
  assert.equal(ping.headers.get('Docker-Distribution-API-Version'), 'registry/2.0');
  assert.equal((await mirror.request('/v2/library/alpine/blobs/uploads/', { method: 'POST' })).status, 405);
  assert.equal((await mirror.request('/v2/library/alpine/tags/unknown')).status, 404);
  assert.equal((await mirror.request('/v2/ghcr.io/alpine/manifests/latest')).status, 404);
  mirror.env.IP_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await mirror.request('/v2/')).status, 429);
  assert.equal(origin.mock.callCount(), 0);
});

test('serves a paginated catalog of configured public image names without reaching upstream', async t => {
  const mirror = fixture();
  const origin = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected fetch'); });
  mirror.env.REGISTRY_CATALOG = 'docker.io/nginx, library/nginx, ghcr.io/astral-sh/uv, busybox:latest';
  const first = await mirror.request('/v2/_catalog?n=1');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { repositories: ['ghcr.io/astral-sh/uv'] });
  const next = first.headers.get('Link');
  assert.equal(next, '</v2/_catalog?n=1&last=ghcr.io%2Fastral-sh%2Fuv>; rel="next"');
  const last = await mirror.request(next.match(/<([^>]+)>/)[1]);
  assert.deepEqual(await last.json(), { repositories: ['library/nginx'] });
  assert.equal(last.headers.get('Link'), null);

  const head = await mirror.request('/v2/_catalog', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal((await mirror.request('/v2/_catalog?n=-1')).status, 400);
  assert.equal(origin.mock.callCount(), 0);
});

test('automatically lists official Docker Hub images and popular public repositories', async t => {
  const mirror = fixture();
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    const page = url.searchParams.get('page');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    requested.push(`${url.hostname}${url.pathname}:${page}`);
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, '/repos/docker-library/official-images/git/trees/master');
      assert.equal(url.searchParams.get('recursive'), '1');
      return Response.json({ tree: [
        { path: 'library/node', type: 'blob' }, { path: 'library/python', type: 'blob' },
        { path: 'README.md', type: 'blob' }, { path: 'library', type: 'tree' },
      ] });
    }
    assert.equal(url.origin, 'https://hub.docker.com');
    assert.equal(url.searchParams.get('page_size'), '100');
    assert.equal(url.pathname, '/v2/search/repositories/');
    assert.equal(url.searchParams.get('query'), '*');
    return page === '1'
      ? Response.json({ results: [{ repo_name: 'nginx' }, { repo_name: 'grafana/grafana' }] })
      : Response.json({ results: [{ repo_name: 'linuxserver/jellyfin' }] });
  });

  const catalog = await mirror.request('/v2/_catalog', { headers: { Authorization: 'Basic visitor' } });
  assert.equal(catalog.status, 200);
  const { repositories } = await catalog.json();
  assert.deepEqual(repositories, [
    'ghcr.io/astral-sh/uv', 'grafana/grafana', 'library/alpine', 'library/mysql', 'library/nginx', 'library/node',
    'library/postgres', 'library/python', 'library/redis', 'library/ubuntu', 'linuxserver/jellyfin',
  ]);
  assert.deepEqual(requested.sort(), [
    'api.github.com/repos/docker-library/official-images/git/trees/master:null',
    'hub.docker.com/v2/search/repositories/:1', 'hub.docker.com/v2/search/repositories/:2',
  ]);
});

test('lists tags from both upstreams and preserves the requested namespace on the next page', async t => {
  const mirror = fixture();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/token') return Response.json({ token: 'scope-token' });
    assert.equal(init.headers.get('Authorization'), 'Bearer scope-token');
    requests.push(`${url.hostname}${url.pathname}${url.search}`);
    const repo = url.hostname === 'ghcr.io' ? 'astral-sh/uv' : 'library/alpine';
    return Response.json({ name: repo, tags: ['latest'] }, {
      headers: { Link: `</v2/${repo}/tags/list?n=1&last=latest>; rel="next"` },
    });
  });

  const hub = await mirror.request('/v2/library/alpine/tags/list?n=1&ns=other.example');
  assert.deepEqual(await hub.json(), { name: 'library/alpine', tags: ['latest'] });
  const ghcr = await mirror.request('/v2/ghcr.io/astral-sh/uv/tags/list?n=1&last=old');
  assert.deepEqual(await ghcr.json(), { name: 'ghcr.io/astral-sh/uv', tags: ['latest'] });
  assert.equal(ghcr.headers.get('Link'), '</v2/ghcr.io/astral-sh/uv/tags/list?n=1&last=latest>; rel="next"');
  assert.deepEqual(requests, [
    'registry-1.docker.io/v2/library/alpine/tags/list?n=1',
    'ghcr.io/v2/astral-sh/uv/tags/list?n=1&last=old',
  ]);
  assert.equal(mirror.objects.size, 0);
});

test('Docker Hub aliases and GHCR use fixed routes, preserving the manifest and its digest', async t => {
  const mirror = fixture();
  mirror.env.DOCKERHUB_USERNAME = 'example';
  mirror.env.DOCKERHUB_PAT = 'example-public-read-token';
  const checks = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/token') {
      const hub = url.hostname === 'auth.docker.io';
      assert.equal(url.searchParams.get('scope'), `repository:${hub ? 'library/alpine' : 'astral-sh/uv'}:pull`);
      assert.equal(init.headers.get('Authorization'), hub ? `Basic ${btoa('example:example-public-read-token')}` : null);
      return Response.json({ token: 'scope-token', expires_in: 60 });
    }

    const hub = url.hostname === 'registry-1.docker.io';
    assert.equal(init.headers.get('Authorization'), 'Bearer scope-token');
    assert.equal(init.headers.get('Accept'), indexType);
    checks.push([url.hostname, url.pathname, init.method]);
    assert.equal(url.pathname, `/v2/${hub ? 'library/alpine' : 'astral-sh/uv'}/manifests/${init.method === 'HEAD' ? 'latest' : digest(index)}`);
    return new Response(init.method === 'HEAD' ? null : index, {
      headers: { 'Content-Type': indexType, 'Content-Length': String(index.length), 'Docker-Content-Digest': digest(index) },
    });
  });

  for (const path of ['docker.io/alpine', 'docker.io/library/alpine', 'library/alpine', 'ghcr.io/astral-sh/uv']) {
    const result = await mirror.request(`/v2/${path}/manifests/latest?ns=example.net`, {
      headers: { Accept: indexType, Authorization: 'Basic visitor-credentials' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Docker-Content-Digest'), digest(index));
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), index);
    await mirror.flush();
  }
  assert.equal(checks.filter(([host, , method]) => host === 'registry-1.docker.io' && method === 'GET').length, 1);
  assert.equal(mirror.objects.size, 2);
});

test('checks the blob before caching and serves HEAD and Range from the independent cache', async t => {
  const mirror = fixture();
  const path = `/v2/ghcr.io/org/repo/blobs/${digest(blob)}`;
  const fetcher = t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/token') return Response.json({ token: 'scope-token' });
    if (url.hostname === 'ghcr.io') {
      return new Response(null, { status: 307, headers: { Location: 'https://objects.example.net/download?sig=example' } });
    }

    assert.equal(url.hostname, 'objects.example.net');
    assert.equal(init.headers.get('Authorization'), null);
    const range = init.headers.get('Range');
    if (range) return new Response(blob.subarray(2, 5), { status: 206, headers: { 'Content-Range': `bytes 2-4/${blob.length}` } });
    return new Response(blob, { headers: { 'Content-Length': String(blob.length) } });
  });

  const coldRange = await mirror.request(path, { headers: { Range: 'bytes=2-4' } });
  assert.equal(coldRange.status, 206);
  assert.deepEqual(Buffer.from(await coldRange.arrayBuffer()), blob.subarray(2, 5));
  assert.equal(mirror.objects.size, 0);

  const cold = await mirror.request(path);
  assert.equal(cold.headers.has('Location'), false);
  assert.deepEqual(Buffer.from(await cold.arrayBuffer()), blob);
  await mirror.flush();
  assert.equal(mirror.objects.size, 1);

  const calls = fetcher.mock.callCount();
  const range = await mirror.request(path, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 2-4/${blob.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), blob.subarray(2, 5));
  const head = await mirror.request(path, { method: 'HEAD' });
  assert.equal(head.headers.get('Content-Length'), String(blob.length));
  assert.equal(head.body, null);
  const invalid = await mirror.request(path, { headers: { Range: 'bytes=100-200' } });
  assert.equal(invalid.status, 416);
  assert.equal(fetcher.mock.callCount(), calls);
});

test('streams manifests and layers directly when R2 is unbound', async t => {
  const mirror = fixture();
  delete mirror.env.CACHE;
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/token') return Response.json({ token: 'scope-token' });
    fetches.push([url.pathname, init.method]);
    if (url.pathname.includes('/manifests/')) {
      return new Response(index, { headers: { 'Content-Type': indexType, 'Docker-Content-Digest': digest(index) } });
    }
    assert.equal(init.headers.get('Range'), 'bytes=2-4');
    return new Response(blob.subarray(2, 5), { status: 206, headers: { 'Content-Range': `bytes 2-4/${blob.length}` } });
  });

  const manifest = 'library/alpine/manifests/latest';
  for (let pull = 0; pull < 2; pull++) {
    const response = await mirror.request(`/v2/docker.io/${manifest}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), index);
  }
  const layer = `org/repo/blobs/${digest(blob)}`;
  const range = await mirror.request(`/v2/ghcr.io/${layer}`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), blob.subarray(2, 5));
  assert.deepEqual(fetches, [[`/v2/${manifest}`, 'GET'], [`/v2/${manifest}`, 'GET'], [`/v2/${layer}`, 'GET']]);
  assert.equal(mirror.objects.size, 0);
});

test('an interrupted or corrupt download does not populate the cache', async t => {
  const mirror = fixture();
  const path = `/v2/docker.io/library/alpine/blobs/${digest(blob)}`;
  let failRead = true;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname === '/token') return Response.json({ token: 'scope-token' });
    const bytes = Buffer.from(blob);
    bytes[0] = 0;
    const body = failRead ? new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 5)); },
      pull(controller) { controller.error(new Error('upstream connection closed')); },
    }) : bytes;
    return new Response(body, { headers: { 'Content-Length': String(blob.length) } });
  });

  const interrupted = await mirror.request(path);
  await assert.rejects(interrupted.arrayBuffer(), /connection closed/);
  await mirror.flush();
  assert.equal(mirror.objects.size, 0);

  failRead = false;
  const corrupt = await mirror.request(path);
  await corrupt.arrayBuffer();
  await mirror.flush();
  assert.equal(mirror.objects.size, 0);
});

test('a private repository denial stays at the mirror', async t => {
  const mirror = fixture();
  mirror.env.DOCKERHUB_USERNAME = 'example';
  mirror.env.DOCKERHUB_PAT = 'example-public-read-token';
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(input).pathname === '/token') {
      assert.equal(init.headers.get('Authorization'), `Basic ${btoa('example:example-public-read-token')}`);
      return Response.json({ token: 'without-private-access' });
    }
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token"' } });
  });
  const result = await mirror.request('/v2/docker.io/org/private/manifests/latest');
  assert.equal(result.status, 403);
  assert.equal(result.headers.has('WWW-Authenticate'), false);
  assert.equal(mirror.objects.size, 0);
});
