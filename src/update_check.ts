import { storageGet, storageSet } from './storage';

/** Releases are tagged vX.Y.Z by .github/workflows/release.yml from Conventional Commits. */
export const RELEASES_API = 'https://api.github.com/repos/juninmd/leilao-helper/releases/latest';
export const UPDATE_KEY = 'astralCometUpdate';
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

export interface UpdateInfo {
  /** Latest released version, without the "v". */
  latest: string;
  /** Release page (notes and downloads). */
  url: string;
  checkedAt: number;
}

export interface UpdateStatus extends UpdateInfo {
  current: string;
  available: boolean;
}

/** "v1.2.3" → "1.2.3"; null for tags that are not plain dotted numbers. */
export function versionFromTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(/^v?(\d+(?:\.\d+){1,3})$/);
  return m ? m[1] : null;
}

/** Numeric comparison of dotted versions: 1.10.0 > 1.9.9. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function currentVersion(): string {
  return globalThis.chrome?.runtime?.getManifest?.().version ?? '0.0.0';
}

const status = (info: UpdateInfo, current: string): UpdateStatus => ({ ...info, current, available: compareVersions(info.latest, current) > 0 });

/**
 * Latest release from GitHub, cached for 12 h in storage.local (the API allows 60 anonymous calls/hour).
 * Never throws: offline, rate-limited or a repo without releases just means "no news".
 */
export async function checkForUpdate(opts: { force?: boolean; now?: number; fetchImpl?: typeof fetch } = {}): Promise<UpdateStatus | null> {
  const now = opts.now ?? Date.now();
  const current = currentVersion();
  const cached = await storageGet<Record<string, unknown>>('local', [UPDATE_KEY]);
  const prev = cached.ok ? (cached.value?.[UPDATE_KEY] as UpdateInfo | undefined) : undefined;
  if (!opts.force && prev && typeof prev.latest === 'string' && now - prev.checkedAt < CHECK_EVERY_MS) return status(prev, current);

  try {
    const res = await (opts.fetchImpl ?? fetch)(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) return prev ? status(prev, current) : null;
    const body = await res.json() as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
    const latest = versionFromTag(body.tag_name);
    if (!latest || body.draft || body.prerelease) return prev ? status(prev, current) : null;
    const info: UpdateInfo = { latest, url: typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : 'https://github.com/juninmd/leilao-helper/releases/latest', checkedAt: now };
    await storageSet('local', { [UPDATE_KEY]: info });
    return status(info, current);
  } catch {
    return prev ? status(prev, current) : null;
  }
}

/** Toolbar badge: "↑" while a newer release exists. */
export function showBadge(s: UpdateStatus | null) {
  const action = globalThis.chrome?.action;
  if (!action) return;
  try {
    void action.setBadgeText({ text: s?.available ? '↑' : '' });
    if (s?.available) void action.setBadgeBackgroundColor({ color: '#9d8cff' });
    void action.setTitle({ title: s?.available ? `Astral Comet: versão ${s.latest} disponível` : 'Configurações' });
  } catch { /* the badge is a hint; never break the caller */ }
}
