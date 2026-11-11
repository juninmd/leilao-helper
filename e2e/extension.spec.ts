import { BrowserContext, expect, Page, test } from '@playwright/test';
import { ApiMode, DETAIL_URL, detailPage, detailPageNoBids, launch, listPage, LIST_URL, Lot, lotCard, mockApis, popupUrl, serve, SHOTS } from './fixtures';

const UNO: Lot = { desc: 'FIAT/UNO MILLE ECONOMY, 08/09', bid: 5000 };      // FIPE 20.000 → profit
const GOL: Lot = { desc: 'I/VW/GOL 1.0 CITY, 12/13', bid: 38000 };            // FIPE 40.000 → loss
const NAVE: Lot = { desc: 'XPTO/NAVE ESPACIAL, 10/11', bid: 1000 };           // unknown brand

let context: BrowserContext;
let api: ApiMode;
let lots: Lot[];

test.beforeEach(async () => {
  context = await launch();
  api = { calls: [] };
  lots = [UNO, GOL, NAVE];
  await mockApis(context, api);
  await serve(context, {
    '/Leiloes/Lotes?id=1': () => listPage(lots),
    '/Leiloes/LoteDetalhes?id=1': () => detailPage(UNO),
    '/Leiloes/LoteDetalhes?id=2': () => detailPageNoBids(UNO),
  });
});
test.afterEach(async () => { await context.close(); });

const open = async (url = LIST_URL) => {
  const page = await context.newPage();
  await page.goto(url);
  return page;
};
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(1100); // let entry animations (count-up, ring, chips) settle
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

// 1 ─ happy path: profit math, colors, FIPE model line
test('list page: profit (green) and loss (red) with page fees', async () => {
  const page = await open();
  const uno = lotCard(page, 0);
  await expect(uno).toContainText('Lucro Estimado');
  // 5000 + 5% (250) + 1900 + 1416 + 0 + 40 + 1500 = 10106 → 20000 - 10106 = 9894
  await expect(uno).toContainText('R$ 10.106,00');
  await expect(uno).toContainText('R$ 9.894,00');
  await expect(uno).toContainText('Comissão Leiloeiro (5%)');
  await expect(uno).toContainText('Uno Mille Economy 1.0 Fire Flex 8V 4p');
  await expect(uno.locator('.fipe-profit')).not.toHaveClass(/negative/);
  await expect.poll(() => uno.evaluate(e => getComputedStyle(e).borderLeftColor)).toBe('rgb(67, 229, 160)'); // waits for the CSS transition

  const gol = lotCard(page, 1);
  await expect(gol).toContainText('Lucro Estimado');
  await expect(gol.locator('.fipe-profit')).toHaveClass(/negative/);
  await expect.poll(() => gol.evaluate(e => getComputedStyle(e).borderLeftColor)).toBe('rgb(255, 138, 101)');
  await shot(page, '01-lista-lotes');
  await uno.locator('.fipe-tab[data-tab="costs"]').click();
  await expect(uno.locator('.fipe-tab[data-tab="costs"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(uno.locator('.fipe-details')).toBeVisible();
  await shot(page, '11-detalhamento-custos');
});

// 2 ─ not found
test('unknown vehicle shows "FIPE não encontrada" without a fake profit', async () => {
  const page = await open();
  const nave = lotCard(page, 2);
  await expect(nave).toContainText('FIPE não encontrada');
  await expect(nave).not.toContainText('Lucro Estimado');
  await expect(nave).toContainText('Custo Total');
  await shot(page, '02-fipe-nao-encontrada');
});

// 2b ─ the auction name only pins down the family: the price is shown but flagged as a guess
test('a guessed variant is labelled "aproximado"; a pinned-down one is not', async () => {
  lots = [UNO, { desc: 'FIAT/PALIO, 08/09', bid: 5000 }, { desc: 'I/VW/GOL CIT 10, 12/13', bid: 38000 }];
  const page = await open();
  await expect(lotCard(page, 1)).toContainText('Palio Fire 1.0');
  await expect(lotCard(page, 1).locator('.fipe-approx')).toHaveText('aproximado');
  await expect(lotCard(page, 0)).toContainText('Uno Mille Economy');
  await expect(lotCard(page, 0).locator('.fipe-approx')).toHaveCount(0);
  await expect(lotCard(page, 2)).toContainText('Gol City 1.0'); // truncated "CIT 10" still finds the variant
  await expect(lotCard(page, 2).locator('.fipe-approx')).toHaveCount(0);
});

// 3 ─ no render loop: DOM settles and API is hit once per resource
test('no infinite re-render loop and API calls are deduplicated', async () => {
  const page = await open();
  await expect(lotCard(page, 0)).toContainText('Lucro Estimado');
  await expect(lotCard(page, 1)).toContainText('Lucro Estimado');
  await page.waitForTimeout(900); // entry animations (profit count-up) end within ~0,5 s
  const mutations = await page.evaluate(() => new Promise<number>(res => {
    let n = 0;
    new MutationObserver(m => { n += m.length; }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    setTimeout(() => res(n), 1500);
  }));
  expect(mutations).toBe(0);
  expect(api.calls.filter(u => u.endsWith('/marcas/v1/carros')).length).toBe(1);
  expect(api.calls.filter(u => /years$/.test(u)).length).toBe(2); // one per distinct model
});

// 4 ─ rate limit + retry
test('rate limit (429) shows a message and "Tentar novamente" recovers', async () => {
  api.price429 = true;
  const page = await open();
  const uno = lotCard(page, 0);
  await expect(uno).toContainText('Limite da API FIPE excedido');
  await expect(uno).not.toContainText('Lucro Estimado');
  await shot(page, '03-limite-api');
  api.price429 = false;
  await uno.locator('.fipe-retry').click();
  await expect(uno).toContainText('Lucro Estimado');
});

// 4b ─ persistent cache (chrome.storage.local) across page loads
const v2Calls = () => api.calls.filter(u => u.includes('fipe.parallelum.com.br'));

test('reloading a lot page reuses stored FIPE answers instead of calling the API again', async () => {
  const first = await open();
  await expect(lotCard(first, 0)).toContainText('Lucro Estimado');
  await expect(lotCard(first, 1)).toContainText('Lucro Estimado');
  const spent = v2Calls().length;
  expect(spent).toBeGreaterThan(0);
  await first.close();

  api.price429 = true; // anything that did reach the API would now fail visibly
  const second = await open();
  await expect(lotCard(second, 0)).toContainText('R$ 9.894,00');
  await expect(lotCard(second, 1)).toContainText('Lucro Estimado');
  expect(v2Calls().length).toBe(spent);
});

// 5 ─ offline
test('API offline shows a connection error', async () => {
  api.offline = true;
  const page = await open();
  await expect(lotCard(page, 0)).toContainText('Não foi possível consultar a FIPE');
  await shot(page, '04-api-offline');
});

// 6 ─ live auction: bid changes
test('bid update re-renders the lot', async () => {
  const page = await open();
  await expect(lotCard(page, 0)).toContainText('R$ 10.106,00');
  await lotCard(page, 0).locator('.fipe-tab[data-tab="costs"]').click(); // stays open across re-renders
  await page.evaluate(() => {
    document.querySelector('#vlr-0')!.textContent = 'R$ 6.000,00';
    (document.querySelector('[data-testid="lot-0"] #hdMaiorLance') as HTMLInputElement).value = '6000';
  });
  // 6000 + 300 + 1900 + 1416 + 40 + 1500 = 11156
  await expect(lotCard(page, 0)).toContainText('R$ 11.156,00');
  await expect(lotCard(page, 0).locator('.fipe-details')).toBeVisible();
});

// 7 ─ IPVA
test('IPVA: charged when unpaid (set via modal), free when page says PAGO', async () => {
  lots = [UNO, { ...UNO, desc: 'FIAT/UNO MILLE ECONOMY, 08/09', fees: '<li>IPVA 2025 PAGO</li><li>5% referente à comissão do leiloeiro</li>' }];
  const page = await open();
  const first = lotCard(page, 0);
  await expect(first).toContainText('Lucro Estimado');
  await expect(first).not.toContainText('IPVA (não pago)');

  await first.locator('.fipe-manual-btn').click();
  await page.fill('.fipe-modal input[name="ipva"]', '800');
  await page.click('.fipe-modal-submit');
  await expect(first).toContainText('IPVA (não pago)');
  // 10106 - (1900+1416 from page? lot has full default fees) + 800 = 10906
  await expect(first).toContainText('R$ 10.906,00');

  const second = lotCard(page, 1);
  await expect(second).toContainText('Lucro Estimado');
  await expect(second).not.toContainText('IPVA (não pago)');
});

// 8 ─ toggle + vehicle picker
test('auto-lookup off → manual mode → picker is prefilled from the lot and submits exact codes', async () => {
  const page = await open();
  const gol = lotCard(page, 1);
  await expect(gol).toContainText('Lucro Estimado');

  await gol.locator('.fipe-auto-toggle').uncheck();
  await expect(gol).toContainText('Modo manual');
  await expect(gol).not.toContainText('Lucro Estimado');
  await shot(page, '05-modo-manual');

  await gol.locator('.fipe-manual-open').click();
  const modal = page.locator('.fipe-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('role', 'dialog');
  const brand = modal.getByRole('combobox', { name: /Marca/ });
  const model = modal.getByRole('combobox', { name: /Modelo/ });
  await expect(brand).toHaveValue('VW - VolksWagen');
  await expect(model).toHaveValue('Gol City 1.0 Flex 8V 4p');
  await expect(modal.locator('#fipe-year')).toHaveValue('2013-1');
  await expect(modal.locator('.fipe-modal-submit')).toBeEnabled();
  await shot(page, '06-modal-selecionar-veiculo');

  // Changing the brand invalidates model and year, and blocks submit until they are chosen again.
  await brand.fill('fiat');
  await expect(model).toBeDisabled();
  await expect(modal.locator('#fipe-year')).toBeDisabled();
  await expect(modal.locator('.fipe-modal-submit')).toBeDisabled();

  // Escape closes the open list first, then the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator('.fipe-combo-pop:visible')).toHaveCount(0);
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  await gol.locator('.fipe-manual-btn').click();
  await brand.fill('fiat');
  await modal.locator('.fipe-combo-pop').getByRole('option', { name: 'Fiat' }).click();
  await expect(model).toBeEnabled();
  await model.fill('uno 1.4');
  await expect(modal.locator('.fipe-combo-pop').getByRole('option')).toHaveCount(1); // multi-token filter: only "Uno Way 1.4"
  await model.press('Enter');
  await expect(model).toHaveValue('Uno Way 1.4 Evo Flex 8V 4p');
  await expect(modal.locator('#fipe-year option')).toHaveText(['Selecione o ano', '2013 Gasolina', '2009 Gasolina']);
  await modal.locator('#fipe-year').selectOption('2009-1');
  await page.click('.fipe-modal-submit');
  await expect(gol).toContainText('Uno Way 1.4 Evo');
  await expect(gol).toContainText('R$ 25.000,00');

  // Reopening shows the last pick, not the lot description.
  await gol.locator('.fipe-manual-btn').click();
  await expect(model).toHaveValue('Uno Way 1.4 Evo Flex 8V 4p');
  await page.keyboard.press('Escape');

  await gol.locator('.fipe-auto-toggle').check();
  await expect(gol).toContainText('Lucro Estimado');
});

test('picker: category filter, keyboard navigation and capped results', async () => {
  const page = await open();
  const nave = lotCard(page, 2); // unknown brand → nothing preselected
  await expect(nave).toContainText('FIPE não encontrada');
  await nave.locator('.fipe-manual-btn').click();
  const modal = page.locator('.fipe-modal');
  await expect(modal.locator('.fipe-modal-status')).toContainText('não identificado');
  await expect(modal.locator('.fipe-modal-submit')).toBeDisabled();

  // Keyboard-only: open, move, select with Enter; aria state follows.
  const brand = modal.getByRole('combobox', { name: /Marca/ });
  await brand.focus();
  await expect(brand).toHaveAttribute('aria-expanded', 'true');
  for (let i = 0; i < 3; i++) await brand.press('ArrowDown'); // catalog order: Fiat, VW, GM
  const activeId = await brand.getAttribute('aria-activedescendant');
  await expect(page.locator(`#${activeId}`)).toHaveText('GM - Chevrolet');
  await brand.press('Enter');
  await expect(brand).toHaveValue('GM - Chevrolet');
  await expect(brand).toHaveAttribute('aria-expanded', 'false');

  // 120 models → capped at 50 with a counter; accent/case-insensitive search narrows it.
  const model = modal.getByRole('combobox', { name: /Modelo/ });
  await expect(model).toBeEnabled(); // models load after the brand is picked
  await model.focus();
  await expect(modal.locator('.fipe-combo-pop').getByRole('option')).toHaveCount(50);
  await expect(modal.locator('.fipe-combo-foot').nth(1)).toContainText('Mostrando 50 de 120');
  await model.fill('ONIX serie 100'); // pick one beyond the first 50, then reopen: the chosen model must lead the list
  await model.press('Enter');
  await expect(model).toHaveValue('Onix Série 100');
  await model.click();
  await expect(modal.locator('.fipe-combo-pop').getByRole('option').first()).toHaveText('Onix Série 100');
  await model.fill('ONIX serie 120');
  await expect(modal.locator('.fipe-combo-pop').getByRole('option')).toHaveCount(1);
  await model.fill('zzz');
  await expect(modal.locator('.fipe-combo-foot').nth(1)).toContainText('Nenhum resultado');
  await page.keyboard.press('Escape');

  // Category filter swaps the whole catalog.
  await modal.getByRole('radio', { name: 'Motos' }).check();
  await brand.focus();
  await expect(modal.locator('.fipe-combo-pop').getByRole('option')).toHaveText(['HONDA']);
  await shot(page, '12-seletor-busca');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('picker: focus is trapped in the dialog and restored on close', async () => {
  const page = await open();
  const uno = lotCard(page, 0);
  await expect(uno).toContainText('Lucro Estimado');
  const trigger = uno.locator('.fipe-manual-btn');
  await trigger.focus();
  await trigger.press('Enter');
  const modal = page.locator('.fipe-modal');
  await expect(modal.locator('.fipe-modal-submit')).toBeEnabled();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.fipe-modal'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('picker: list failure shows a message and "Tentar novamente" recovers', async () => {
  const page = await open();
  const uno = lotCard(page, 0);
  await expect(uno).toContainText('Lucro Estimado');
  await uno.locator('.fipe-manual-btn').click();
  const modal = page.locator('.fipe-modal');
  await expect(modal.locator('#fipe-year')).toHaveValue('2009-1'); // car lists come from the lookup cache
  api.offline = true;
  await modal.getByRole('combobox', { name: /Marca/ }).fill('chev'); // Chevrolet models were never fetched → network
  await modal.locator('.fipe-combo-pop').getByRole('option', { name: 'GM - Chevrolet' }).click();
  await expect(modal.locator('.fipe-modal-status')).toContainText('Não foi possível carregar os modelos');
  await expect(modal.getByRole('combobox', { name: /Modelo/ })).toBeDisabled();
  api.offline = false;
  await modal.locator('.fipe-modal-retry').click();
  await expect(modal.getByRole('combobox', { name: /Modelo/ })).toBeEnabled();
});

test('picker: re-choosing the current brand keeps model and year; short viewports can still reach the buttons', async () => {
  const page = await open();
  const gol = lotCard(page, 1);
  await expect(gol).toContainText('Lucro Estimado');
  await gol.locator('.fipe-manual-btn').click();
  const modal = page.locator('.fipe-modal');
  await expect(modal.locator('.fipe-modal-submit')).toBeEnabled();
  const brand = modal.getByRole('combobox', { name: /Marca/ });
  await brand.focus();
  await brand.press('Enter'); // current brand is highlighted: choosing it again must not reset anything below
  await expect(modal.getByRole('combobox', { name: /Modelo/ })).toHaveValue('Gol City 1.0 Flex 8V 4p');
  await expect(modal.locator('#fipe-year')).toHaveValue('2013-1');
  await expect(modal.locator('.fipe-modal-submit')).toBeEnabled();

  await page.setViewportSize({ width: 1100, height: 420 });
  await modal.locator('.fipe-modal-submit').scrollIntoViewIfNeeded();
  const box = await modal.locator('.fipe-modal-submit').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);
  await modal.locator('.fipe-modal-cancel').click();
  await expect(modal).toHaveCount(0);
});

// 8b ─ break-even bid
test('shows the maximum bid that avoids a loss, with the gap to the current bid', async () => {
  const page = await open();
  // Uno: (20000 − (1900+1416+40+1500)) / 1.05 = 14422.857 → floor to the cent
  const uno = lotCard(page, 0);
  await expect(uno.locator('.fipe-maxbid')).toContainText('Lance máximo (sem prejuízo)');
  await expect(uno.locator('.fipe-maxbid')).toContainText('R$ 14.422,85');
  await expect(uno.locator('.fipe-maxbid')).toContainText('Folga de R$ 9.422,85');
  await expect(uno.locator('.fipe-maxbid')).not.toHaveClass(/negative/);
  // Gol: (40000 − 4856) / 1.05 = 33470.47; bid 38000 already above it
  const gol = lotCard(page, 1);
  await expect(gol.locator('.fipe-maxbid')).toContainText('R$ 33.470,47');
  await expect(gol.locator('.fipe-maxbid')).toContainText('Lance atual excede em R$ 4.529,53');
  await expect(gol.locator('.fipe-maxbid')).toHaveClass(/negative/);
  await expect(lotCard(page, 2).locator('.fipe-maxbid')).toHaveCount(0); // no FIPE → no recommendation
  await shot(page, '13-lance-maximo');
});

// 8b' ─ lot without bids: the bid is the initial bid, never a number read back from our own panel
test('lot with no bids uses the initial bid and does not feed on its own panel', async () => {
  const page = await open('https://www.freitasleiloeiro.com.br/Leiloes/LoteDetalhes?id=2');
  const panel = page.locator('#fipe-detail-helper');
  await expect(panel).toContainText('Lucro Estimado');
  await panel.locator('.fipe-tab[data-tab="costs"]').click();
  const bidRow = panel.locator('.fipe-row', { hasText: 'Lance (Maior/Inicial)' }).locator('.fipe-value');
  await expect(bidRow).toHaveText('R$ 5.000,00'); // UNO.bid doubles as the initial bid in this fixture
  // Poke the page like the live site does when it refreshes the bid area, then re-check: it must not drift.
  await page.evaluate(() => { document.querySelector('#dvMaiorLance')!.append(document.createElement('span')); });
  await page.waitForTimeout(800);
  await expect(bidRow).toHaveText('R$ 5.000,00');
  await expect(panel).toContainText('R$ 9.894,00'); // same profit as the list page at the same bid
});

// 8c ─ wording used by the live site
test('reads the fees as worded on the live site ("Despesas operacionais")', async () => {
  lots = [{ desc: 'FIAT/UNO MILLE ECONOMY, 08/09', bid: 5000, fees: `
    <li><span style="font-weight: 700;">5%</span> referente à comissão do leiloeiro acrescido ao valor da arrematação;</li>
    <li> Despesas operacionais no valor de <span style="font-weight: 700;">R$ 2.350,00</span> por conta do comprador; </li>
    <li>Despesas de logística no valor de <span style="font-weight: 700;">R$ 350,00</span> por conta do comprador;</li>` }];
  const page = await open();
  const card = lotCard(page, 0);
  await expect(card).toContainText('Lucro Estimado');
  await card.locator('.fipe-tab[data-tab="costs"]').click();
  // 5000 + 250 + 2350 + 350 + 40 + 1500 = 9490
  await expect(card.locator('.fipe-details')).toContainText('R$ 2.350,00');
  await expect(card).toContainText('R$ 9.490,00');
});

// 9 ─ detail page
test('detail page shows the panel once, above the description', async () => {
  const page = await open(DETAIL_URL);
  const panel = page.locator('#fipe-detail-helper');
  await expect(panel).toContainText('Lucro Estimado');
  await expect(page.locator('#fipe-detail-helper')).toHaveCount(1);
  await expect(page.locator('.fipe-radar')).toHaveCount(0); // one lot: nothing to compare
  await shot(page, '07-detalhe-lote');
});

// 10 ─ popup + settings propagate to the page
test('popup: defaults, save, persistence, reset, invalid input; settings reach the page', async () => {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(popupUrl());
  await expect(popup.locator('#commissionRate')).toHaveValue('5');
  await expect(popup.locator('#adminFee')).toHaveValue('1900');
  await expect(popup.locator('#logisticsFee')).toHaveValue('1416');
  await expect(popup.locator('#towing')).toHaveValue('1500');
  await expect(popup.locator('#extraCosts')).toHaveValue('0');
  await shot(popup, '08-popup-config');

  // page with no fee list → settings are used (commission default 5% = 5/100, not 500%)
  lots = [{ desc: UNO.desc, bid: 5000, fees: '' }];
  const page = await open();
  await expect(lotCard(page, 0)).toContainText('Lucro Estimado');
  // 5000 + 250 + 1900 + 1416 + 40 + 1500 = 10106
  await expect(lotCard(page, 0)).toContainText('R$ 10.106,00');

  await popup.fill('#towing', '2000');
  await popup.fill('#commissionRate', '10');
  await popup.fill('#extraCosts', '-5');          // browser validation (min=0) blocks the submit
  await popup.click('button[type="submit"]');
  await expect(popup.locator('#success')).toBeHidden();
  expect(await popup.locator('#extraCosts').evaluate((e: HTMLInputElement) => e.validity.rangeUnderflow)).toBe(true);
  await popup.fill('#extraCosts', '');             // empty → default 0
  await popup.fill('#adminFee', '');               // empty → default
  await popup.click('button[type="submit"]');
  await expect(popup.locator('#success')).toBeVisible();
  await shot(popup, '09-popup-salvo');
  await expect(popup.locator('#extraCosts')).toHaveValue('0');
  await expect(popup.locator('#adminFee')).toHaveValue('1900');
  // live update on the already-open lot page: 5000 + 500 + 1900 + 1416 + 0 + 40 + 2000 = 10856
  await expect(lotCard(page, 0)).toContainText('R$ 10.856,00');
  await expect(lotCard(page, 0)).toContainText('Comissão Leiloeiro (10%)');

  await popup.reload();
  await expect(popup.locator('#towing')).toHaveValue('2000');
  await expect(popup.locator('#commissionRate')).toHaveValue('10');

  await popup.click('#reset');
  await expect(popup.locator('#towing')).toHaveValue('1500');
  await expect(popup.locator('#commissionRate')).toHaveValue('5');
  await expect(lotCard(page, 0)).toContainText('R$ 10.106,00');

  await popup.fill('#commissionRate', '250');      // max=100 → browser validation blocks the submit
  await popup.click('button[type="submit"]');
  await expect(popup.locator('#success')).toBeHidden();
  expect(await popup.locator('#commissionRate').evaluate((e: HTMLInputElement) => e.validity.rangeOverflow)).toBe(true);
});

// 10b ─ buyer tools
const saveSettings = async (values: Record<string, string>) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl());
  for (const [id, value] of Object.entries(values)) await popup.fill(`#${id}`, value);
  await popup.click('button[type="submit"]');
  await expect(popup.locator('#success')).toBeVisible();
  await popup.close();
};

test('resale discount and target margin change profit and the maximum bid', async () => {
  await saveSettings({ resaleDiscount: '20', targetMargin: '10' });
  const page = await open(DETAIL_URL);
  const panel = page.locator('#fipe-detail-helper');
  // resale 20.000 × 0,8 = 16.000; cost 10.106 → 5.894
  await expect(panel).toContainText('R$ 5.894,00');
  // floor(((16.000 / 1,1 − 4.856) / 1,05) × 100) / 100 = 9.228,05
  await expect(panel.locator('.fipe-maxbid')).toContainText('Lance máximo (lucro de 10%)');
  await expect(panel.locator('.fipe-maxbid')).toContainText('R$ 9.228,05');
  await panel.locator('.fipe-tab[data-tab="costs"]').click();
  await expect(panel).toContainText('Revenda estimada (FIPE −20%)');
  await shot(page, '14-revenda-e-meta');
});

test('red-flag words in the lot text show as chips; negated or clean lots show none', async () => {
  lots = [
    { desc: 'FIAT/UNO MILLE ECONOMY, 08/09 - SUCATA, sem documentação', bid: 5000 },
    { desc: 'FIAT/UNO MILLE ECONOMY, 08/09 - veículo sem sinistro', bid: 5000 },
    UNO,
    // Auction-wide conditions copied in shape from the live site: the disclaimer is not a finding, the debt cap is a cost.
    { desc: 'FIAT/UNO MILLE ECONOMY, 08/09 IPVA 2026 PAGO / A CONCRETIZAÇÃO DA ARREMATAÇÃO SOMENTE SERÁ REALIZADA EM NOME DE QUEM PAGOU, E SINISTROS JÁ OCORRIDOS EM QUALQUER CLASSIFICAÇÃO DE MONTA OU TIPO CORRERÃO P/C DO COMPRADOR / DÉBITOS ATE R$ 500,00 P/C DO COMPRADOR', bid: 5000 },
  ];
  const page = await open();
  const risky = lotCard(page, 0);
  await expect(risky.locator('.fipe-risk')).toHaveText(['Sucata / baixa definitiva', 'Sem documentação / cadastro']);
  await expect(risky.locator('.fipe-risks')).toHaveAttribute('aria-label', 'Alertas do lote');
  await expect(lotCard(page, 1)).toContainText('Lucro Estimado');
  await expect(lotCard(page, 1).locator('.fipe-risk')).toHaveCount(0);
  await expect(lotCard(page, 2).locator('.fipe-risk')).toHaveCount(0);
  const wide = lotCard(page, 3);
  await expect(wide).toContainText('Lucro Estimado');
  await expect(wide.locator('.fipe-risk')).toHaveText(['Débitos até R$ 500,00 por conta do comprador']);
  await shot(page, '15-alertas-de-risco');
});

test('my lot: favorite, checklist, target bid and notes persist, and the popup lists the favorite', async () => {
  const page = await open(DETAIL_URL);
  const panel = page.locator('#fipe-detail-helper');
  await expect(panel).toContainText('Lucro Estimado');
  const fav = panel.locator('.fipe-fav');
  await expect(fav).toHaveAttribute('aria-pressed', 'false');
  const lotTab = panel.locator('.fipe-tab[data-tab="lot"]');
  await lotTab.click();
  await expect(lotTab).toHaveAttribute('aria-expanded', 'true');
  await fav.click();
  await panel.locator('.fipe-checklist input').nth(0).check();
  await panel.locator('.fipe-checklist input').nth(2).check();
  await panel.locator('.fipe-target').fill('12000.50'); // a dot before two digits is a decimal point, not R$ 1.200.050
  await expect(panel.locator('.fipe-target-note')).toContainText('2.422,35 abaixo do lance máximo');
  await panel.locator('.fipe-target').fill('16.000,00');
  await panel.locator('.fipe-note-field').fill('Pneus carecas; <b>conferir</b> chave reserva');
  await expect(lotTab).toContainText('(2/6)');
  await expect(panel.locator('.fipe-check-count')).toHaveText('2/6');
  // max bid 14.422,85 → the target is 1.577,15 above it
  await expect(panel.locator('.fipe-target-note')).toContainText('1.577,15 acima do lance máximo');
  await expect(panel.locator('.fipe-risk')).toHaveCount(0); // the checklist mentions "sucata" but is not lot text
  await shot(page, '16-meu-lote');
  await page.waitForTimeout(600); // debounced save
  await page.close();

  const again = await open(DETAIL_URL);
  const back = again.locator('#fipe-detail-helper');
  await expect(back.locator('.fipe-fav')).toHaveAttribute('aria-pressed', 'true');
  await expect(back.locator('.fipe-tab[data-tab="lot"]')).toContainText('(2/6)');
  await expect(back.locator('.fipe-target')).toHaveValue('16.000,00');
  await expect(back.locator('.fipe-note-field')).toHaveValue('Pneus carecas; <b>conferir</b> chave reserva');
  await expect(back.locator('.fipe-notes b')).toHaveCount(0); // notes are text, never markup

  const popup = await context.newPage();
  await popup.goto(popupUrl());
  await popup.click('#tab-favs');
  const item = popup.locator('#favList li');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('FIAT/UNO MILLE ECONOMY');
  await expect(item).toContainText('Alvo R$');
  await expect(item.locator('a')).toHaveAttribute('href', DETAIL_URL);
  await shot(popup, '17-popup-favoritos');
  await item.locator('button').click();
  await expect(popup.locator('#favList li')).toHaveCount(0);
  await expect(popup.locator('#favEmpty')).toBeVisible();

  await again.reload();
  await expect(again.locator('#fipe-detail-helper .fipe-fav')).toHaveAttribute('aria-pressed', 'false');
  await expect(again.locator('#fipe-detail-helper .fipe-note-field')).toHaveValue('Pneus carecas; <b>conferir</b> chave reserva'); // notes outlive the favorite
});

test('popup counts API requests, and reloading cached lots does not spend more', async () => {
  const page = await open();
  await expect(lotCard(page, 1)).toContainText('Lucro Estimado');
  const popup = await context.newPage();
  const count = async () => {
    await popup.goto(popupUrl());
    const text = (await popup.locator('#quotaText').textContent()) ?? '';
    return { n: Number(text.match(/hoje: (\d+) de 500/)?.[1] ?? NaN), text };
  };
  const first = await count();
  expect(first.n).toBeGreaterThan(0);
  expect(first.n).toBe(api.calls.filter(u => u.includes('fipe.parallelum.com.br')).length);
  await page.reload();
  await expect(lotCard(page, 1)).toContainText('Lucro Estimado');
  expect((await count()).n).toBe(first.n);
  await popup.click('#tab-api');
  await popup.fill('#fipeToken', 'abc');
  await popup.click('button[type="submit"]');
  await expect(popup.locator('#quotaText')).toContainText('de 1000');
});

test('picker explains when to enter IPVA', async () => {
  const page = await open();
  await lotCard(page, 0).locator('.fipe-manual-btn').click();
  await expect(page.locator('.fipe-modal .fipe-hint')).toContainText('edital');
});

// 10c ─ deal score and bid simulator
test('deal score and verdict; the bid simulator recomputes profit and slack, and resets', async () => {
  const page = await open();
  const uno = lotCard(page, 0);
  await expect(uno).toContainText('R$ 9.894,00');
  // 97,9% over cost → 30 + 137 → capped at 100
  await expect(uno.locator('.fipe-score')).toHaveAttribute('aria-label', 'Nota do negócio 100 de 100: Excelente');
  await expect(lotCard(page, 1).locator('.fipe-score')).toHaveAttribute('aria-label', /Evite$/);

  const range = uno.locator('.fipe-sim-range');
  await expect(range).toHaveValue('5000');
  await range.evaluate((el: HTMLInputElement) => { el.value = '10000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  // 10000 + 500 + 4856 = 15356 → 20000 − 15356 = 4644
  await expect(uno.locator('.fipe-sim-bid')).toHaveText('R$ 10.000,00');
  await expect(uno.locator('.fipe-profit')).toContainText('R$ 4.644,00');
  await expect(uno.locator('.fipe-maxbid')).toContainText('Folga de R$ 4.422,85 sobre o lance simulado');
  await uno.locator('.fipe-tab[data-tab="costs"]').click();
  await expect(uno.locator('.fipe-row', { hasText: 'Lance (Maior/Inicial)' })).toContainText('R$ 10.000,00');
  await shot(page, '19-simulador-de-lance');

  await uno.locator('.fipe-sim-reset').click();
  await expect(uno.locator('.fipe-profit')).toContainText('R$ 9.894,00');
  await expect(uno.locator('.fipe-sim-reset')).toBeHidden();
  await expect(range).toHaveValue('5000');
});

// 10d ─ radar on the list page
test('radar summarizes the page, flags the best lot, sorts by profit and dims the rest', async () => {
  lots = [GOL, NAVE, UNO];
  const page = await open();
  await expect(lotCard(page, 2)).toContainText('Lucro Estimado');
  const radar = page.locator('.fipe-radar');
  await expect(radar).toBeVisible();
  await expect(radar).toContainText('2 de 3 lotes com FIPE');
  await expect(radar).toContainText('1 oportunidade');
  await expect(radar).toContainText('melhor: FIAT UNO MILLE ECONOMY');
  await expect(lotCard(page, 2).locator('.fipe-best')).toBeVisible();
  await expect(lotCard(page, 0).locator('.fipe-best')).toBeHidden();

  const col = (i: number) => page.locator(`[data-testid="lot-${i}"]`).locator('xpath=..');
  await radar.getByRole('button', { name: 'Maior lucro' }).click();
  await expect(radar.getByRole('button', { name: 'Maior lucro' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => col(2).evaluate(e => getComputedStyle(e).order)).toBe('1'); // Uno first
  await expect.poll(() => col(1).evaluate(e => getComputedStyle(e).order)).toBe('3'); // no FIPE last

  await radar.getByRole('button', { name: 'Só oportunidades' }).click();
  await expect(col(0)).toHaveAttribute('data-fipe-dim', '');
  await expect(col(2)).not.toHaveAttribute('data-fipe-dim');
  await shot(page, '18-radar-do-leilao');

  await radar.getByRole('button', { name: 'Ordem do site' }).click();
  await expect.poll(() => col(2).evaluate(e => getComputedStyle(e).order)).toBe('0');
  await radar.getByRole('button', { name: 'Minimizar radar' }).click();
  await expect(radar).toContainText('Radar · 1 oportunidade');
});

// 10e ─ update check against GitHub releases
test('popup: no banner on the latest version; a newer release shows the banner and the version line', async () => {
  const popup = await context.newPage();
  await popup.goto(popupUrl());
  await popup.click('#tab-api');
  await expect(popup.locator('#updateStatus')).toHaveText('você está na versão mais recente');
  await expect(popup.locator('#updateBanner')).toBeHidden();

  api.latestRelease = 'v9.9.0';
  await popup.click('#checkUpdate');
  const banner = popup.locator('#updateBanner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Versão 9.9.0 disponível');
  await expect(popup.locator('#updateLink')).toHaveAttribute('href', 'https://github.com/juninmd/leilao-helper/releases/tag/v9.9.0');
  await expect(popup.locator('#updateStatus')).toHaveText('9.9.0 disponível');
  await shot(popup, '20-popup-atualizacao');

  await popup.reload(); // cached for 12 h: the banner stays without a new request
  await expect(banner).toBeVisible();
});

// 11 ─ non-matching pages are left alone
test('page without lots is untouched', async () => {
  lots = [];
  const page = await open();
  await page.waitForTimeout(600);
  await expect(page.locator('.fipe-helper-container')).toHaveCount(0);
});

// 12 ─ real BrasilAPI + FIPE v2 (only the auction site is a fixture). Run with LIVE=1.
test('live APIs: real FIPE price shows up in the page', async () => {
  test.skip(!process.env.LIVE, 'set LIVE=1 to hit the real FIPE APIs');
  await context.unroute(/brasilapi\.com\.br|fipe\.parallelum\.com\.br/);
  lots = [{ desc: 'VW/GOL 1.0 CITY, 12/13', bid: 15000 }];
  const page = await open();
  const card = lotCard(page, 0);
  await expect(card).toContainText('Valor FIPE', { timeout: 30000 });
  await expect(card).toContainText('Gol City');
  await shot(page, '10-fipe-real');
});
