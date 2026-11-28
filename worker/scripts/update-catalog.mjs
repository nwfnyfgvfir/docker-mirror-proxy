import { readFile, writeFile } from 'node:fs/promises';
import { parseRepository } from '../src/registry.ts';

const hub = 'https://hub.docker.com';
const pageSize = 100;
const maxNamespaces = 100;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'docker-mirror-proxy' },
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

function searchPage(page, ordering) {
  const url = new URL('/v2/search/repositories/', hub);
  url.search = new URLSearchParams({ query: '*', page: String(page), page_size: String(pageSize) });
  if (ordering) url.searchParams.set('ordering', ordering);
  return getJson(url);
}

const [official, ...search] = await Promise.all([
  getJson(new URL('https://api.github.com/repos/docker-library/official-images/git/trees/master?recursive=1')),
  searchPage(1),
  searchPage(2),
]);
const repositories = new Set();
const namespaces = new Set();

function addRepository(name) {
  const repo = parseRepository(name);
  if (repo?.source !== 'docker.io') return;
  repositories.add(repo.repository);
  const namespace = repo.repository.split('/')[0];
  if (namespace !== 'library') namespaces.add(namespace);
}

for (const entry of official.tree) {
  if (entry.type === 'blob' && /^library\/[^/]+$/.test(entry.path)) addRepository(entry.path);
}
for (const { results } of search) {
  for (const image of results) {
    if (typeof image.repo_name === 'string') addRepository(image.repo_name);
  }
}

const ranked = await Promise.allSettled([
  searchPage(1, '-pull_count'), searchPage(2, '-pull_count'),
  searchPage(1, '-star_count'), searchPage(2, '-star_count'),
]);
for (const page of ranked) {
  if (page.status !== 'fulfilled') continue;
  for (const image of page.value.results) {
    if (typeof image.repo_name === 'string') addRepository(image.repo_name);
  }
}

const publishers = [...namespaces].slice(0, maxNamespaces);
let failed = 0;
for (let offset = 0; offset < publishers.length; offset += 4) {
  const batch = await Promise.allSettled(publishers.slice(offset, offset + 4).map(async namespace => {
    const url = new URL(`/v2/namespaces/${encodeURIComponent(namespace)}/repositories`, hub);
    url.searchParams.set('page_size', String(pageSize));
    const { results } = await getJson(url);
    for (const image of results) {
      if (typeof image.name === 'string' && image.is_private !== true) addRepository(`${namespace}/${image.name}`);
    }
  }));
  failed += batch.filter(result => result.status === 'rejected').length;
}

const file = new URL('../src/docker-hub-catalog.json', import.meta.url);
const names = [...repositories].sort();
const previous = await readFile(file, 'utf8').then(JSON.parse, error => {
  if (error.code !== 'ENOENT') throw error;
});
if (previous && failed && names.length < previous.repositories.length) {
  throw new Error('Publisher requests failed while refreshing the catalog. Keeping the current snapshot.');
}
if (JSON.stringify(names) !== JSON.stringify(previous?.repositories)) {
  const snapshot = { updated_at: new Date().toISOString(), repositories: names };
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}
console.log(`Bundled ${repositories.size} public repositories from the Docker Hub index and ${publishers.length - failed} publishers.`);
if (failed) console.warn(`${failed} publisher listings were unavailable.`);
