import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker from '../worker/src/index.ts';

// The ports are bound to localhost on the VPS, with NGINX enforcing rate limits.
const nginxLimit = { limit: async () => ({ success: true }) };
const env = {
  IP_LIMIT: nginxLimit,
  TOTAL_LIMIT: nginxLimit,
  DOCKERHUB_USERNAME: process.env.DOCKERHUB_USERNAME,
  DOCKERHUB_PAT: process.env.DOCKERHUB_PAT,
};

for (const [port, registry] of [[5001, 'docker.io'], [5002, 'ghcr.io']]) {
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.once('close', () => abort.abort());

    try {
      const url = new URL(`http://localhost${incoming.url}`);
      // NGINX selects the port and passes the registry path without the source prefix.
      url.pathname = url.pathname.replace(/^\/v2\/(?=.)/, `/v2/${registry}/`);
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        signal: abort.signal,
      });
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch (error) {
      if (abort.signal.aborted) return;
      console.warn('Proxy request failed', error.message);
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    }
  });
  server.listen(port, '0.0.0.0');
}
