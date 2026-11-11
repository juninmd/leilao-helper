import { describe, expect, it } from 'vitest';
import { bumpOf, latestTag, nextVersion, parseCommit, parseVersion, releaseNotes, updatesManifest } from '../scripts/release_lib.mts';

const c = (subject: string, body = '') => ({ subject, body });

describe('conventional commits → bump', () => {
  it('parses type, scope, breaking mark and description', () => {
    expect(parseCommit(c('feat(ui): nova UI (#35)'))).toEqual({ type: 'feat', scope: 'ui', breaking: false, description: 'nova UI (#35)' });
    expect(parseCommit(c('refactor!: drop v1 storage'))?.breaking).toBe(true);
    expect(parseCommit(c('fix: x', 'BREAKING CHANGE: settings moved'))?.breaking).toBe(true);
    expect(parseCommit(c('Merge pull request #15 from juninmd/feat/x'))).toBeNull();
  });

  it('takes the highest bump; chores, docs and merges release nothing', () => {
    expect(bumpOf([c('chore(deps): bump x (#34)'), c('docs: readme'), c('Merge pull request #1')])).toBeNull();
    expect(bumpOf([c('chore: a'), c('fix(parse): b')])).toBe('patch');
    expect(bumpOf([c('perf: a')])).toBe('patch');
    expect(bumpOf([c('fix: a'), c('feat: b')])).toBe('minor');
    expect(bumpOf([c('feat: a'), c('feat(api)!: b')])).toBe('major');
  });
});

describe('versions', () => {
  it('bumps semver and resets the lower parts', () => {
    expect(nextVersion('1.4.2', 'patch')).toBe('1.4.3');
    expect(nextVersion('1.4.2', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(nextVersion('1.4.2', null)).toBeNull();
    expect(nextVersion('1.4', 'patch')).toBeNull(); // browsers need dotted numbers; refuse to guess
  });

  it('accepts only vX.Y.Z tags and sorts them numerically', () => {
    expect(parseVersion('v10.0.1')).toEqual([10, 0, 1]);
    expect(parseVersion('v2026.11.10-abc1234')).toBeNull();
    expect(latestTag(['v1.9.0', 'v1.10.0', 'v2026.11.10-abc', 'nightly', 'v1.2.3'])).toBe('v1.10.0');
    expect(latestTag([''])).toBeNull();
  });
});

describe('release artifacts', () => {
  it('groups notes and links PR numbers', () => {
    const notes = releaseNotes([c('feat(ui): radar (#40)'), c('fix: slider'), c('chore: x'), c('feat!: novo storage')], '2.0.0', 'o/r');
    expect(notes).toContain('## v2.0.0');
    expect(notes).toMatch(/Mudanças incompatíveis\n- novo storage/);
    expect(notes).toContain('- **ui:** radar ([#40](https://github.com/o/r/pull/40))');
    expect(notes).toContain('### 🐛 Correções\n- slider');
    expect(notes).not.toContain('chore');
  });

  it('builds the Firefox update manifest with a sha256 hash', () => {
    expect(updatesManifest('id@x', '1.2.0', 'https://h/a.xpi', 'ab12')).toEqual({
      addons: { 'id@x': { updates: [{ version: '1.2.0', update_link: 'https://h/a.xpi', update_hash: 'sha256:ab12' }] } },
    });
  });
});
