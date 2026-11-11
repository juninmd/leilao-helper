/**
 * Release helper for .github/workflows/release.yml. Run with `node --experimental-strip-types scripts/release.mts <cmd>`.
 *
 *   next                       → prints `version=`, `bump=` and `tag=` lines (for $GITHUB_OUTPUT); writes release/notes.md
 *   package <version>          → stages release/chrome and release/firefox, zips Chrome as leilao-helper-<v>-chrome.zip
 *   updates <version> <xpi>    → writes release/updates.json for Firefox auto-update
 */
import { execFileSync } from 'node:child_process';
import { cpSync, createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { bumpOf, type Commit, latestTag, nextVersion, releaseNotes, updatesManifest } from './release_lib.mts';

export const NAME = 'leilao-helper';
const REPO = process.env.GITHUB_REPOSITORY || 'juninmd/leilao-helper';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'release');
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const readJson = (file: string) => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));

export const UPDATES_URL = `https://github.com/${REPO}/releases/latest/download/updates.json`;
const assetUrl = (version: string, file: string) => `https://github.com/${REPO}/releases/download/v${version}/${file}`;

function commitsSince(tag: string | null): Commit[] {
  const SEP = '\u001e';
  const raw = git('log', '--format=%s%n%b' + SEP, ...(tag ? [`${tag}..HEAD`] : ['HEAD']));
  return raw.split(SEP).map(chunk => chunk.trim()).filter(Boolean).map(chunk => {
    const [subject, ...body] = chunk.split('\n');
    return { subject, body: body.join('\n') };
  });
}

function next() {
  const tag = latestTag(git('tag', '--list', 'v*').split('\n'));
  const current = tag ? tag.slice(1) : readJson('manifest.json').version;
  const commits = commitsSince(tag);
  const bump = bumpOf(commits);
  const version = nextVersion(current, bump);
  mkdirSync(OUT, { recursive: true });
  if (version) writeFileSync(resolve(OUT, 'notes.md'), releaseNotes(commits, version, REPO));
  console.log(`version=${version ?? ''}`);
  console.log(`bump=${bump ?? ''}`);
  console.log(`tag=${version ? `v${version}` : ''}`);
  console.error(version ? `${tag ?? 'sem tag'} → v${version} (${bump}, ${commits.length} commits)` : `Nada para lançar desde ${tag ?? 'o início'}.`);
}

function stage(dir: string, manifest: Record<string, unknown>) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(ROOT, 'dist'), resolve(dir, 'dist'), { recursive: true });
  cpSync(resolve(ROOT, 'LICENSE'), resolve(dir, 'LICENSE'));
  writeFileSync(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function pack(version: string) {
  const manifest = { ...readJson('manifest.json'), version };
  const gecko = manifest.browser_specific_settings.gecko;

  // Chrome ignores browser_specific_settings; leave it out of the Chrome build entirely.
  const { browser_specific_settings: _gecko, ...chrome } = manifest;
  stage(resolve(OUT, 'chrome'), chrome);
  // Firefox: signed builds point at the latest release's updates.json and update themselves.
  stage(resolve(OUT, 'firefox'), { ...manifest, browser_specific_settings: { gecko: { ...gecko, update_url: UPDATES_URL } } });

  const zip = resolve(OUT, `${NAME}-${version}-chrome.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: resolve(OUT, 'chrome') });
  console.error(`Chrome: ${zip}`);
}

async function updates(version: string, xpi: string) {
  const hash = createHash('sha256');
  await new Promise<void>((done, fail) => createReadStream(xpi).on('data', d => hash.update(d)).on('end', () => done()).on('error', fail));
  const id = readJson('manifest.json').browser_specific_settings.gecko.id;
  const body = updatesManifest(id, version, assetUrl(version, `${NAME}-${version}-firefox.xpi`), hash.digest('hex'));
  writeFileSync(resolve(OUT, 'updates.json'), `${JSON.stringify(body, null, 2)}\n`);
  console.error(`updates.json → ${body.addons[id].updates[0].update_link}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'next') next();
else if (cmd === 'package' && args[0]) pack(args[0]);
else if (cmd === 'updates' && args[0] && args[1]) await updates(args[0], args[1]);
else {
  console.error('uso: release.mts next | package <versão> | updates <versão> <arquivo.xpi>');
  process.exit(1);
}
