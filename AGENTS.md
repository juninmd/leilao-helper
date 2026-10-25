# AGENTS.md - Astral Comet

Extensão Chrome/Firefox (MV3) que mostra FIPE e lucro estimado nos lotes do Freitas Leiloeiro.

## Tech Stack
- **Linguagem:** TypeScript (strict), bundler **tsup** (IIFE), gerenciador **pnpm**
- **Testes:** vitest (unit) + Playwright (e2e com a extensão carregada em Chromium)
- **Dev Firefox:** web-ext
- **APIs:** BrasilAPI (marcas/modelos) + FIPE API v2 `fipe.parallelum.com.br` (anos/preço)

## Structure
```
src/content_script.ts   # injeta o card nas páginas; MutationObserver, modo manual, erros
src/vehicle_picker.ts   # modal "Selecionar veículo" (categoria → marca → modelo → ano)
src/combobox.ts         # combobox acessível (teclado) usado pelo seletor
src/search.ts           # busca/filtro de modelos por vários termos, sem acento
src/fipe_service.ts     # consulta FIPE: marca → modelo (ranking) → ano → preço; cache + FipeError
src/model_match.ts       # ranking de modelos: leituras de token, sinônimos, família, flag approximate
src/depara.ts            # tabelas de de-para (marcas, siglas, reescritas por marca, não-FIPE); toda entrada vem de lote real
src/fipe_http.ts        # fetch com timeout, cache persistente (storage.local), cópia reserva em erro, pausa após 429
src/persistent_cache.ts # cache por tabela de referência FIPE, cooldown e contador de cota
src/lib.ts              # funções puras: parseCurrency, parseDescription, calculate (revenda, meta, lance máximo)
src/risks.ts            # chips de risco a partir do texto do lote (ignora o aviso genérico do leilão)
src/lot_store.ts        # favorito/checklist/lance-alvo/notas por lote (storage.local); src/lot_notes.ts é a UI
src/settings.ts         # defaults e acesso ao chrome.storage.sync
src/popup.{html,ts}     # configurações de custos e token FIPE
src/styles.css          # CSS injetado
tests/                  # vitest (lib, fipe_service, search, live opcional)
e2e/                    # Playwright: fixtures (páginas do leilão + mock das APIs) e specs
docs/screenshots/       # prints gerados pelo e2e (usados no README)
manifest.json           # MV3, Chrome + Firefox (gecko id)
```

## Commands
- `pnpm install` / `pnpm build` / `pnpm watch`
- `pnpm typecheck` · `pnpm test` · `pnpm test:e2e` · `pnpm lint:ext`
- `LIVE=1 pnpm test` / `LIVE=1 pnpm test:e2e` → incluem chamadas às APIs reais
- `pnpm dev` → Firefox via web-ext

## CI gates
- `ci.yml`: Node 22, `pnpm install --frozen-lockfile` → `typecheck` → `test` → `build` → `lint:ext` → e2e Playwright. Rode o mesmo antes de abrir PR.
- `validate.yml`: reusable de `juninmd/base-actions` (lint só avisa; auditoria de dependências `high` bloqueia).
- `security.yml`: Gitleaks (reusable de `base-actions`). Nunca commitar token FIPE ou `.env`.
- `release-drafter.yml`: rascunho de release, não bloqueia.

## Conventions
- TypeScript strict; manifest compatível Chrome/Firefox; UI injetada via CSS próprio (`.fipe-*`).
- Nome novo do leilão que não casa: adicione a entrada em `depara.ts` + caso em `tests/model_match.test.ts` (nome real do lote, nome FIPE real). Não afrouxe o matcher.
- Lógica pura vai em `lib.ts` com teste unitário; comportamento de DOM vai coberto no e2e.
- `commissionRate` é guardado em **%** no storage (popup) e convertido para fração em `settings.ts`; a comissão lida da página já é fração.
- A resposta real da BrasilAPI usa `{ modelo, valor }` nos modelos e `{ nome, valor }` nas marcas; a FIPE v2 usa `{ code, name }` e `price`. Não presumir outros nomes.
- Mutações do próprio DOM da extensão (`.fipe-helper-container`, `.fipe-modal-overlay`) são ignoradas pelo observer — mantenha assim para evitar loop de renderização.
- Rodar e2e: Chromium em `/opt/pw-browsers` (ou `CHROME_PATH`); não rodar `playwright install`.
- O site do leilão retorna 403 para automação: use as fixtures de `e2e/fixtures.ts`, nunca scraping real.
- Texto de UI em português (pt-BR).

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.