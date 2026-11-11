import { CHECKLIST, LotStore, safeLotUrl } from './lot_store';
import { chromeBackend, readUsage } from './persistent_cache';
import { getToken } from './settings';

// Documented FIPE v2 daily limits (fipe.api.br): 500 unauthenticated, 1.000 with the free token.
export const DAILY_LIMIT = { anon: 500, token: 1000 };
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** "Consultas hoje" meter: what this extension sent, so the buyer knows when a token is worth getting. */
export async function renderQuota(): Promise<void> {
  const backend = chromeBackend();
  const text = document.getElementById('quotaText');
  const fill = document.getElementById('quotaFill');
  const hint = document.getElementById('quotaHint');
  if (!backend || !text || !fill || !hint) return;

  const [usage, token] = await Promise.all([readUsage(backend), getToken()]);
  const used = token ? usage.token : usage.anon;
  const limit = token ? DAILY_LIMIT.token : DAILY_LIMIT.anon;
  const ratio = Math.min(used / limit, 1);
  text.textContent = `Consultas hoje: ${used} de ${limit} (aprox.)`;
  fill.style.setProperty('--p', ratio.toFixed(3));
  fill.classList.toggle('high', ratio >= 0.8);
  const pct = document.getElementById('quotaPct');
  if (pct) pct.textContent = `${Math.round(ratio * 100)}%`;
  hint.textContent = ratio >= 0.8 && !token
    ? 'Perto do limite. Cadastre um token gratuito em fipe.api.br para dobrar a cota.'
    : 'Contagem desta extensão; respostas já guardadas não gastam cota.';
}

/** Favorite lots saved from the lot page, with the buyer's target bid. */
export async function renderFavorites(): Promise<void> {
  const store = LotStore.fromChrome();
  const list = document.getElementById('favList');
  const empty = document.getElementById('favEmpty');
  if (!store || !list || !empty) return;

  const favorites = await store.favorites();
  list.replaceChildren(...favorites.map(fav => {
    const item = document.createElement('li');
    const href = safeLotUrl(fav.url);
    const title = document.createElement(href ? 'a' : 'span');
    title.textContent = fav.title || 'Lote sem título';
    if (title instanceof HTMLAnchorElement && href) { title.href = href; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const checked = `${fav.checks.length}/${CHECKLIST.length} itens do checklist`;
    meta.textContent = fav.target ? `Alvo ${brl.format(fav.target)} · ${checked}` : checked;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round((fav.checks.length / CHECKLIST.length) * 100)}%`;
    fill.classList.toggle('full', fav.checks.length === CHECKLIST.length);
    bar.append(fill);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remover';
    remove.setAttribute('aria-label', `Remover dos favoritos: ${title.textContent}`);
    remove.addEventListener('click', () => { void store.unfavorite(fav.key).then(renderFavorites); });
    item.append(title, meta, bar, remove);
    return item;
  }));
  empty.hidden = favorites.length > 0;
  const count = document.getElementById('favCount');
  if (count) count.textContent = favorites.length ? `· ${favorites.length}` : '';
}
