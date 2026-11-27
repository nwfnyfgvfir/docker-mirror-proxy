import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const wrangler = fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json')));
const cacheRules = [
  { name: 'docker-mirror-expire-dockerhub', prefix: 'docker.io/' },
  { name: 'docker-mirror-expire-ghcr', prefix: 'ghcr.io/' },
];
const expireDays = 7;

function run(args, capture = false) {
  return execFileSync(process.execPath, [wrangler, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
}

function getCacheBucket() {
  const deployment = JSON.parse(run(['deployments', 'status', '--json'], true));
  const versionId = deployment.versions.find(version => version.percentage === 100)?.version_id;
  if (!versionId) throw new Error('Could not find the active Worker version.');

  const version = JSON.parse(run(['versions', 'view', versionId, '--json'], true));
  const bucket = version.resources.bindings.find(binding => binding.type === 'r2_bucket' && binding.name === 'CACHE');
  if (!bucket?.bucket_name) throw new Error('Could not find the R2 bucket bound to CACHE.');
  return bucket;
}

function configureCache() {
  const bucket = getCacheBucket();
  const jurisdiction = bucket.jurisdiction ? ['--jurisdiction', bucket.jurisdiction] : [];
  const lifecycle = ['r2', 'bucket', 'lifecycle'];
  const listRules = () => {
    const output = stripVTControlCharacters(run([...lifecycle, 'list', bucket.bucket_name, ...jurisdiction], true));
    // Wrangler prints each rule as four labelled lines.
    return [...output.matchAll(/^name:[ \t]*(.*)\r?\nenabled:[ \t]*(Yes|No)\r?\nprefix:[ \t]*(.*)\r?\naction:[ \t]*(.*)$/gm)]
      .map(([, name, enabled, prefix, action]) => ({ name, enabled, prefix, action }));
  };
  const covers = (rules, prefix) => rules.some(rule =>
    rule.enabled === 'Yes' &&
    rule.action.split(', ').includes(`Expire objects after ${expireDays} days`) &&
    (rule.prefix === '(all prefixes)' || prefix.startsWith(rule.prefix)),
  );

  let rules = listRules();
  for (const { name, prefix } of cacheRules) {
    if (covers(rules, prefix)) continue;
    if (rules.some(rule => rule.name === name)) {
      throw new Error(`R2 lifecycle rule ${name} already exists with different settings. Review it in the R2 dashboard and redeploy.`);
    }
    run([...lifecycle, 'add', bucket.bucket_name, name, prefix, '--expire-days', String(expireDays), ...jurisdiction]);
    rules = listRules();
    if (!covers(rules, prefix)) throw new Error(`Could not verify the R2 lifecycle rule for ${prefix}.`);
  }
  console.log(`R2 cache in ${bucket.bucket_name} is set to expire after ${expireDays} days.`);
}

const args = process.argv.slice(2);
try {
  run(['deploy', ...args]);
} catch (error) {
  if (error.status === null || error.status === undefined) console.error(error.message);
  process.exit(error.status ?? 1);
}

// Forward custom Wrangler invocations, including --dry-run, without touching R2.
if (args.length === 0) {
  try {
    configureCache();
  } catch (error) {
    console.error(`Worker deployed, but automatic R2 cache expiry could not be confirmed. ${error.message}`);
    process.exitCode = 1;
  }
}
