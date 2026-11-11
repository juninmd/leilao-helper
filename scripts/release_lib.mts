/**
 * Semantic versioning from Conventional Commits, for the release workflow.
 * Pure functions only (no git, no fs): scripts/release.mts does the I/O.
 *
 * feat → minor · fix/perf/revert → patch · "!" or "BREAKING CHANGE:" → major · anything else → no release.
 */

export type Bump = 'major' | 'minor' | 'patch';
export interface Commit { subject: string; body: string }
export interface ParsedCommit { type: string; scope: string; breaking: boolean; description: string }

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };
const PATCH_TYPES = new Set(['fix', 'perf', 'revert']);

export function parseCommit(c: Commit): ParsedCommit | null {
  const m = c.subject.trim().match(HEADER);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ?? '',
    breaking: Boolean(m[3]) || /^BREAKING[ -]CHANGE:/m.test(c.body),
    // Squash merges end with " (#123)": keep it, the release notes link it.
    description: m[4].trim(),
  };
}

export function bumpOf(commits: readonly Commit[]): Bump | null {
  let best: Bump | null = null;
  for (const c of commits) {
    const p = parseCommit(c);
    if (!p) continue;
    const bump: Bump | null = p.breaking ? 'major' : p.type === 'feat' ? 'minor' : PATCH_TYPES.has(p.type) ? 'patch' : null;
    if (bump && (!best || RANK[bump] > RANK[best])) best = bump;
  }
  return best;
}

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; null for anything else (browsers only accept dotted numbers). */
export function parseVersion(text: string): [number, number, number] | null {
  const m = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function nextVersion(current: string, bump: Bump | null): string | null {
  const v = parseVersion(current);
  if (!v || !bump) return null;
  const [major, minor, patch] = v;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Newest "vX.Y.Z" tag by version order (not by date), or null. */
export function latestTag(tags: readonly string[]): string | null {
  const valid = tags.filter(t => /^v\d+\.\d+\.\d+$/.test(t.trim())).map(t => t.trim());
  valid.sort((a, b) => {
    const x = parseVersion(a)!, y = parseVersion(b)!;
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return valid.at(-1) ?? null;
}

const SECTIONS: [string, (p: ParsedCommit) => boolean][] = [
  ['⚠️ Mudanças incompatíveis', p => p.breaking],
  ['🚀 Novidades', p => !p.breaking && p.type === 'feat'],
  ['🐛 Correções', p => !p.breaking && PATCH_TYPES.has(p.type)],
];

export function releaseNotes(commits: readonly Commit[], version: string, repo: string): string {
  const parsed = commits.map(parseCommit).filter((p): p is ParsedCommit => p !== null);
  const link = (text: string) => text.replace(/\(#(\d+)\)/g, `([#$1](https://github.com/${repo}/pull/$1))`);
  const line = (p: ParsedCommit) => `- ${p.scope ? `**${p.scope}:** ` : ''}${link(p.description)}`;
  const parts = [`## v${version}`];
  for (const [title, match] of SECTIONS) {
    const items = parsed.filter(match);
    if (items.length) parts.push(`### ${title}\n${items.map(line).join('\n')}`);
  }
  parts.push([
    '### 📦 Instalação',
    '- **Firefox**: instale o `.xpi` assinado; as próximas versões chegam sozinhas pela atualização automática do navegador.',
    '- **Chrome / Edge**: baixe o `-chrome.zip`, extraia na pasta da extensão e clique em *Recarregar* em `chrome://extensions`. O popup avisa quando houver versão nova.',
  ].join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/** Firefox self-hosted update manifest (https://extensionworkshop.com/documentation/manage/updating-your-extension/). */
export function updatesManifest(addonId: string, version: string, link: string, sha256: string) {
  return { addons: { [addonId]: { updates: [{ version, update_link: link, update_hash: `sha256:${sha256}` }] } } };
}
