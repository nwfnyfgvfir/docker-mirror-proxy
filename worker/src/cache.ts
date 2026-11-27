import { protocolHeaders, sha256 } from './registry.ts';
import type { Route } from './registry.ts';

const maxCachedBytes = 1024 ** 3;

function objectKey(route: Route): string {
  return `${route.source}/${route.repository}/${route.kind}/${route.reference}`;
}

function acceptsManifest(request: Request, route: Route, object: R2Object): boolean {
  const accept = request.headers.get('Accept');
  if (!accept || route.kind === 'blobs') return true;
  const type = object.httpMetadata?.contentType?.split(';')[0].toLowerCase();
  if (!type) return false;
  return accept.split(',').some(entry => {
    const [media, ...params] = entry.trim().toLowerCase().split(';');
    if (params.some(param => /^\s*q=0(?:\.0+)?\s*$/.test(param))) return false;
    return media.trim() === type || media.trim() === '*/*' || media.trim() === `${type.split('/')[0]}/*`;
  });
}

interface ByteRange {
  offset: number;
  length: number;
}

function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | undefined {
  const range = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!range || (!range[1] && !range[2])) return;
  if (!size) return 'unsatisfiable';
  if (!range[1]) {
    const length = Math.min(size, Number(range[2]));
    if (!length) return 'unsatisfiable';
    return { offset: size - length, length };
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

export async function readCache(bucket: R2Bucket, route: Route, request: Request): Promise<Response | undefined> {
  if (!sha256.test(route.reference)) return;
  const key = objectKey(route);
  const etag = `"${route.reference}"`;
  const head = request.method === 'HEAD';
  const ifRange = request.headers.get('If-Range');
  const rangeHeader = !head && route.kind === 'blobs' && (!ifRange || ifRange === etag)
    ? request.headers.get('Range')
    : null;

  const headers = protocolHeaders();
  headers.set('Docker-Content-Digest', route.reference);
  headers.set('ETag', etag);
  if (route.kind === 'blobs') headers.set('Accept-Ranges', 'bytes');

  let selection: ByteRange | undefined;
  if (rangeHeader) {
    const metadata = await bucket.head(key);
    if (!metadata) return;
    const range = parseRange(rangeHeader, metadata.size);
    if (range === 'unsatisfiable') {
      // If-None-Match is evaluated before Range.
      if (matchesETag(request.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers });
      headers.set('Content-Range', `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    selection = range;
  }

  const object = head ? await bucket.head(key) : await bucket.get(key, selection && { range: selection });
  if (!object) return;
  const body = 'body' in object ? (object as R2ObjectBody).body : null;
  if (!acceptsManifest(request, route, object)) {
    await body?.cancel();
    return;
  }
  if (matchesETag(request.headers.get('If-None-Match'), etag)) {
    await body?.cancel();
    return new Response(null, { status: 304, headers });
  }

  const type = object.httpMetadata?.contentType;
  if (type) headers.set('Content-Type', type);
  headers.set('Content-Length', String(selection?.length ?? object.size));
  if (selection) {
    const { offset, length } = selection;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  }
  return new Response(body, { status: selection ? 206 : 200, headers });
}

function matchesETag(value: string | null, etag: string): boolean {
  return Boolean(value?.split(',').some(entry => {
    const candidate = entry.trim().replace(/^W\//, '');
    return candidate === '*' || candidate === etag;
  }));
}

// A full upstream response is streamed to both destinations with backpressure.
// R2 commits the object only if the complete stream matches the requested SHA-256.
export function cacheStream(bucket: R2Bucket, route: Route, response: Response, headers: Headers, ctx: ExecutionContext): ReadableStream<Uint8Array> | null {
  const body = response.body;
  const type = headers.get('Content-Type');
  const length = Number(headers.get('Content-Length'));
  if (!body || response.status !== 200 || !sha256.test(route.reference) || !type ||
      !Number.isSafeInteger(length) || length <= 0 || length > maxCachedBytes ||
      (headers.has('Content-Encoding') && headers.get('Content-Encoding') !== 'identity')) return body;

  const client = new FixedLengthStream(length);
  const storage = new FixedLengthStream(length);
  const clientWriter = client.writable.getWriter();
  const storageWriter = storage.writable.getWriter();
  let storageFinished = false;

  const save = bucket.put(objectKey(route), storage.readable, {
    sha256: route.reference.slice('sha256:'.length),
    httpMetadata: { contentType: type },
  }).catch(() => {
    console.warn('R2 cache write failed', route.source, route.kind);
  }).finally(() => { storageFinished = true; });

  async function writeToStorage(write: () => Promise<void>): Promise<void> {
    if (!storageFinished) await Promise.race([write().catch(() => undefined), save]);
  }

  const transfer = body.pipeTo(new WritableStream<Uint8Array>({
    async write(chunk) {
      await Promise.all([clientWriter.write(chunk), writeToStorage(() => storageWriter.write(chunk))]);
    },
    async close() {
      await Promise.all([clientWriter.close(), writeToStorage(() => storageWriter.close())]);
    },
  })).catch(async (error: unknown) => {
    await Promise.allSettled([clientWriter.abort(error), storageWriter.abort(error)]);
  });

  ctx.waitUntil(Promise.all([transfer, save]));
  return client.readable;
}
