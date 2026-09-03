const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
/** Loaded for the console colour helpers it installs as a side effect. */
require('./helpers');

/**
 * Captures the production configuration that exists in no other place.
 *
 * Two things run the deployment and neither is in git. `librechat.yaml` is a
 * Coolify file mount, stored Laravel-encrypted in the coolify-db; the ~56
 * environment variables live only in that same database. Losing the Coolify
 * instance therefore loses the entire production configuration — the code would
 * redeploy fine and have no idea which models to offer, which proxy to route
 * them through, or how to sign a token.
 *
 * The Coolify API cannot supply the second half: its token has no
 * `read:sensitive`, so `GET /applications/<uuid>/envs` returns the keys with no
 * `value` field at all. The values have to be read out of the running container,
 * which is why this goes over SSH rather than over the API.
 *
 * Deliberately not encrypted here. An encrypted blob whose passphrase lives in
 * someone's memory is a backup that fails exactly when it is needed, and the
 * output lands beside `.env.sshpass` — a file that already grants root on the
 * same host, so the marginal exposure is small. It is written 0600 into a
 * gitignored directory. Put it somewhere durable yourself; a copy that only
 * exists on the same laptop is not a backup.
 *
 * Read-only against production: it reads a file and reads env, and changes
 * nothing.
 *
 * Usage:
 *   npm run backup-prod-config
 */

const ROOT = path.resolve(__dirname, '..');
const SSHPASS_FILE = path.join(ROOT, '.env.sshpass');
const COOLIFY_ENV = path.join(ROOT, '.env.coolify');
const APP_UUID = 's3foenolqvjpvc8jlrf8e7wz';

/** Read from `.env.coolify` rather than pinned here, so this follows the
 *  deployment if it ever moves. `SSH_HOST` is preferred over parsing
 *  `COOLIFY_BASE_URL`: the latter is a shell-quoted value, and stripping quotes
 *  well enough to hand to `new URL` is more code than reading the key that
 *  already holds exactly what is wanted. */
function productionHost() {
  if (!fs.existsSync(COOLIFY_ENV)) {
    return null;
  }
  const text = fs.readFileSync(COOLIFY_ENV, 'utf8');
  const unquote = (value) => value.trim().replace(/^["']|["']$/g, '');

  const sshHost = /^SSH_HOST=(.+)$/m.exec(text);
  if (sshHost) {
    return unquote(sshHost[1]);
  }
  const baseUrl = /^COOLIFY_BASE_URL=(.+)$/m.exec(text);
  if (!baseUrl) {
    return null;
  }
  try {
    return new URL(unquote(baseUrl[1])).hostname;
  } catch {
    return null;
  }
}

function ssh(host, script) {
  return execFileSync(
    'sshpass',
    [
      '-f',
      SSHPASS_FILE,
      'ssh',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=20',
      `root@${host}`,
      'bash -s',
    ],
    { input: script, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
}

(async () => {
  console.purple('----------------------------------------');
  console.purple('Production config backup');
  console.purple('----------------------------------------');

  for (const file of [SSHPASS_FILE, COOLIFY_ENV]) {
    if (!fs.existsSync(file)) {
      console.red(`  missing ${path.basename(file)} — cannot reach production`);
      process.exit(1);
    }
  }

  const host = productionHost();
  if (!host) {
    console.red('  could not read COOLIFY_BASE_URL from .env.coolify');
    process.exit(1);
  }
  console.cyan(`  host: ${host}`);

  /** One SSH round trip, not three: each one re-authenticates, and a partial
   *  capture is worse than none — it would look like a backup. */
  const remote = `
set -e
CID=$(docker ps --format '{{.Names}}' | grep '^${APP_UUID}' | head -1)
[ -z "$CID" ] && { echo "__ERR__ no running container for ${APP_UUID}"; exit 1; }
echo "__IMAGE__"
docker ps --filter "name=$CID" --format '{{.Image}}'
echo "__YAML__"
cat /data/coolify/applications/${APP_UUID}/app/librechat.yaml
echo "__ENV__"
docker exec "$CID" printenv
`;

  let output;
  try {
    output = ssh(host, remote);
  } catch (error) {
    console.red(`  SSH failed: ${error.message.split('\n')[0]}`);
    process.exit(1);
  }

  if (output.includes('__ERR__')) {
    console.red(`  ${output.split('__ERR__')[1].trim()}`);
    process.exit(1);
  }

  const image = output.split('__IMAGE__')[1]?.split('__YAML__')[0]?.trim() ?? '';
  const yamlText = output.split('__YAML__')[1]?.split('__ENV__')[0] ?? '';
  const envText = output.split('__ENV__')[1] ?? '';

  /** `printenv` also emits the container's own PATH, HOSTNAME and friends.
   *  Keeping them would bury the ~56 that matter among Docker's noise, and
   *  restoring them would be actively wrong. */
  const CONTAINER_NOISE = new Set([
    'PATH',
    'HOSTNAME',
    'HOME',
    'PWD',
    'SHLVL',
    'TERM',
    'NODE_VERSION',
    'YARN_VERSION',
    '_',
  ]);
  const envLines = envText
    .split('\n')
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .filter((line) => !CONTAINER_NOISE.has(line.slice(0, line.indexOf('='))))
    .sort();

  if (!yamlText.trim() || envLines.length === 0) {
    console.red('  captured nothing — refusing to write a backup that is not one');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, 'backups', `prod-config-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const write = (name, body) =>
    fs.writeFileSync(path.join(dir, name), body, { encoding: 'utf8', mode: 0o600 });

  write('librechat.yaml', yamlText.replace(/^\n/, ''));
  write('env', `${envLines.join('\n')}\n`);
  write(
    'MANIFEST.txt',
    [
      `captured_at: ${new Date().toISOString()}`,
      `host:        ${host}`,
      `app_uuid:    ${APP_UUID}`,
      `image:       ${image}`,
      `env_keys:    ${envLines.length}`,
      '',
      'Contains production secrets in plaintext. Copy somewhere durable and',
      'off this machine; a backup that only exists next to the thing it backs',
      'up is not a backup.',
      '',
      'To restore: recreate the Coolify application from this repo, set these',
      'env vars, and mount librechat.yaml. See the coolify-deploy notes for the',
      'three-step config write (host file + encrypted DB + restart) — writing',
      'only the host file gets overwritten on the next deploy.',
      '',
      'Keys captured:',
      ...envLines.map((line) => `  ${line.slice(0, line.indexOf('='))}`),
    ].join('\n'),
  );

  console.green(`  librechat.yaml: ${yamlText.trim().split('\n').length} lines`);
  console.green(`  env:            ${envLines.length} variables`);
  console.cyan(`  image:          ${image.split(':').pop()}`);
  console.purple('----------------------------------------');
  console.green(`  written to backups/prod-config-${stamp}/`);
  console.orange('\n  Plaintext secrets. Move a copy off this machine.');
  process.exit(0);
})();

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error:');
  console.error(err);
  process.exit(1);
});
