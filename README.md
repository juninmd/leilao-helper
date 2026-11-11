# Leilão FIPE Helper 🚗💨

Extensão para Chrome/Brave/Edge e Firefox (Manifest V3) que consulta a **Tabela FIPE** nos lotes do **Freitas Leiloeiro** e calcula o **custo total e o lucro estimado** de cada veículo.

![Lista de lotes](docs/screenshots/01-lista-lotes.png)

## ✨ Funcionalidades

- **Consulta FIPE automática** em cada lote (lista e página de detalhes), com o modelo FIPE encontrado e o mês de referência.
- **Custos lidos da própria página** (comissão, despesas administrativas/operacionais, logística, "IPVA pago"); quando o lote não informa, usa os valores configurados no popup.
- **Cálculo de lucro**: lance + comissão + despesas adm/org/dep + logística + custos extras + ATPV-e + guincho + IPVA (se não pago). Verde = lucro, laranja = prejuízo (com ▲/▼, não só cor).
- **Nota do negócio (0–100)**: anel animado com veredito (Excelente, Bom negócio, Apertado, Evite). Parte do retorno sobre o custo total (`30 + 1,4 × %`) e desconta 12 pontos por alerta de risco alto e 4 por alerta leve. Serve para comparar lotes; quem decide é o edital.
- **Para onde vai a revenda**: barra que divide a revenda em lance, comissão, taxas fixas e lucro (ou marca onde a revenda fica abaixo do custo).
- **Simulador de lance**: deslize o lance e veja lucro, nota, detalhamento e folga até o lance máximo mudarem na hora. A faixa verde vai até o lance máximo; *Voltar ao atual* restaura o lance da página.
- **Radar do leilão** (lista de lotes): barra acima dos lotes com quantos têm FIPE, quantas oportunidades (nota ≥ 55), quantos têm risco alto e qual é o melhor (selo *Melhor do leilão* no card). Ordena por maior lucro ou maior nota sem mexer no HTML do site (só a ordem visual), destaca só as oportunidades e leva até o melhor lote.
- **Lance máximo recomendado**: o maior lance que ainda não dá prejuízo contra a FIPE, já com comissão e todas as despesas (`(FIPE − custos fixos) / (1 + comissão)`, arredondado para baixo no centavo). Mostra a folga sobre o lance atual ou quanto ele já excede; "Inviável" quando os custos fixos superam a FIPE.
- **Revenda e meta (popup)**: *Desconto na revenda sobre a FIPE* (carro de leilão costuma vender abaixo da tabela) e *Lucro-alvo sobre o custo total*. O lucro passa a ser medido contra `FIPE × (1 − desconto)` e o lance máximo garante a meta: `(revenda / (1 + meta) − custos fixos) / (1 + comissão)`. Reparos entram em *Custos Extras*. Com os dois em 0 nada muda.
- **Alertas de risco**: chips com palavras de risco do texto do lote (sucata, sinistro, alagamento, danos estruturais, sem documentação, Renajud, motor, "débitos até R$ X por conta do comprador"). Frases negadas ("sem sinistro") não contam, e o aviso genérico que o Freitas repete em todos os lotes ("sinistros já ocorridos em qualquer classificação de monta") é ignorado. É um ponteiro para o edital, não um veredito.
- **Meu lote** (página de detalhe, aba do card): favoritar, **checklist de compra** (edital, débitos e restrições, vistoria, credenciamento da leiloeira, documentação, valor à vista), **lance-alvo** comparado ao lance máximo e anotações. Tudo fica só neste navegador. Os favoritos aparecem no popup.
- **Visual "cockpit noturno"**: card escuro que se destaca na página clara do leilão, números tabulares, lucro que conta a partir de zero, anel e barras animados, chips de risco que surgem em sequência. Abas *Detalhamento dos custos* e *Meu lote* (a aba aberta é mantida quando o lance atualiza), chave *Auto* para a consulta automática, *skeleton* com brilho de carregamento e alertas com ícone e ação. Tudo respeita `prefers-reduced-motion`.
- **Match inteligente**: normaliza acentos, entende abreviações do leilão (`VW`, `GM`, `M.BENZ`, `I/` de importado), mantém cilindrada (`1.0`) e testa as variantes mais parecidas até achar o ano do modelo (±1 ano como fallback). Procura em carros, motos e caminhões.
- **Tabelas de de-para** (`src/depara.ts`): o leilão imprime o nome do Detran (cortado em ~20 caracteres, sem vogais/espaços: `HB20S 10M EVOLUTI`, `CRETA1TF`, `KGOO`). O matcher lê motor (`10`→1.0, `1016`→1.0 + 16v), palavras cortadas, siglas (`MT`, `HL`, `TB`), marcas (`VW`, `GM`, `LR`, `H-D`) e a marca depois do `I/` de importados, escolhe a melhor categoria (carro, moto, caminhão) e marca **aproximado** quando só a família do modelo casou ou o ano usado foi o vizinho. Reboques (`SR/`) são ignorados sem gastar cota. Em ~500 descrições reais de lotes, a taxa de achados passou de 57% para 98%.
- **Modo manual / Selecionar veículo**: desligue a "Consulta automática" ou clique em **Selecionar veículo** para escolher o veículo direto na tabela FIPE, num diálogo com trilha de etapas (o que já foi escolhido, o que falta) e resumo da seleção: **categoria** (cartões carros, motos, caminhões) → **marca** → **modelo** (busca com filtro por vários termos, sem acento e sem diferenciar maiúsculas; mostra até 50 resultados e informa o total) → **ano** (os anos reais daquele modelo). Já abre preenchido com o que foi detectado no lote, funciona só com o teclado (↑ ↓ Home End Enter Esc, foco preso no diálogo) e a consulta usa os códigos FIPE exatos. Também informa o IPVA.
- **Erros tratados**: "FIPE não encontrada" (mostra só os custos, sem lucro falso, com atalho para *Selecionar veículo*), limite da API excedido e falta de conexão, ambos com **Tentar novamente**. No modo manual, *Consultar este lote* faz uma consulta avulsa sem religar o automático.
- **Popup em abas** (*Custos*, *Favoritos*, *API*): **prévia ao vivo** do lance máximo de um carro de FIPE R$ 30.000 enquanto você mexe nas taxas, controles deslizantes para desconto na revenda e lucro-alvo, anel da cota diária, favoritos com progresso do checklist. Atualiza na hora as abas abertas.

| Simulador de lance | Radar do leilão |
|---|---|
| ![](docs/screenshots/19-simulador-de-lance.png) | ![](docs/screenshots/18-radar-do-leilao.png) |

**Detalhamento dos custos** (aba):

![Detalhamento dos custos](docs/screenshots/11-detalhamento-custos.png)

| Alertas de risco | Meu lote | Favoritos e cota (popup) |
|---|---|---|
| ![](docs/screenshots/15-alertas-de-risco.png) | ![](docs/screenshots/16-meu-lote.png) | ![](docs/screenshots/17-popup-favoritos.png) |

| FIPE não encontrada | Limite da API | Modo manual |
|---|---|---|
| ![](docs/screenshots/02-fipe-nao-encontrada.png) | ![](docs/screenshots/03-limite-api.png) | ![](docs/screenshots/05-modo-manual.png) |

| Selecionar veículo | Detalhe do lote | Configurações |
|---|---|---|
| ![](docs/screenshots/06-modal-selecionar-veiculo.png) | ![](docs/screenshots/07-detalhe-lote.png) | ![](docs/screenshots/08-popup-config.png) |

## 🚀 Instalação

Requisitos: Node.js 22 (versão usada no CI) e pnpm 10 (`packageManager` do `package.json`).

```bash
pnpm install
pnpm build        # gera dist/
```

**Chrome / Brave / Edge:** `chrome://extensions` → ative o *Modo do desenvolvedor* → *Carregar sem compactação* → selecione a pasta do projeto.

**Firefox (140+):** `about:debugging#/runtime/this-firefox` → *Carregar extensão temporária…* → selecione `manifest.json`. Ou `pnpm dev` (web-ext).

## ⚙️ Configuração (popup)

| Campo | Padrão | Observação |
|---|---|---|
| Comissão (%) | 5 | Usada só se a página não informar a comissão |
| Despesas Adm/Org/Dep | R$ 1.900,00 | Idem |
| Despesas Logística | R$ 1.416,00 | Idem |
| Guincho | R$ 1.500,00 | Estimativa |
| Custos extras | R$ 0,00 | |
| Token API FIPE | — | Opcional: aumenta o limite da API FIPE v2 ([fipe.api.br](https://fipe.api.br)) |

ATPV-e é fixo em R$ 40,00. O IPVA é informado em **Selecionar veículo** e só entra quando a página não indica "IPVA ... PAGO".

## 🌐 APIs usadas

- **BrasilAPI** (`brasilapi.com.br/api/fipe`): marcas e modelos.
- **FIPE API v2** (`fipe.parallelum.com.br/api/v2`): anos e preço. Sem token o limite é de **500 requisições por dia** (1.000 com token gratuito de [fipe.api.br](https://fipe.api.br)).
  - **Cache local** (`chrome.storage.local`, só respostas da FIPE v2): a tabela FIPE é mensal, então anos e preços valem **até a FIPE publicar a próxima tabela**. A extensão pergunta `/references` (no máximo 2 vezes por dia) para saber qual é a atual; se essa checagem falhar, vale uma janela de 3 dias. Sobrevive a recargas e a novas abas.
  - **Contador de cota** no popup: quantas consultas a extensão fez hoje (aproximado) e aviso para cadastrar token perto do limite.
  - **429**: a extensão usa a cópia guardada (até 45 dias) em vez de mostrar erro, e pausa novas chamadas por 5 minutos (por cota: com token é outra cota). **Tentar novamente** ignora a pausa.

## 🛠️ Desenvolvimento

| Comando | O que faz |
|---|---|
| `pnpm build` / `pnpm watch` | Compila com tsup para `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Testes unitários (vitest). `LIVE=1 pnpm test` também consulta as APIs reais |
| `pnpm test:e2e` | Build + Playwright: carrega a extensão num Chromium real e exercita lista, detalhe, popup, erros, seletor de veículo e lance máximo. `LIVE=1` inclui um teste com as APIs reais. Gera os prints em `docs/screenshots/` |
| `pnpm lint:ext` | `web-ext lint` do build |
| `pnpm dev` | Firefox com web-ext |

Estrutura: `src/content_script.ts` (UI nas páginas), `src/vehicle_picker.ts` + `src/combobox.ts` + `src/search.ts` (seletor de veículo), `src/fipe_service.ts` (consulta/catálogo), `src/model_match.ts` + `src/depara.ts` (match e tabelas de de-para), `src/fipe_http.ts` + `src/persistent_cache.ts` (HTTP, cache persistente e pausa no 429), `src/lib.ts` (parse e cálculo), `src/settings.ts` (storage), `src/popup.*`, `e2e/` (fixtures e testes).

## 🔒 Gates de CI

| Workflow | O que checa |
|---|---|
| `CI` (`ci.yml`) | Node 22, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint:ext` e o e2e do Playwright com a extensão no Chromium |
| `Validate` (`validate.yml`) | Reutiliza `juninmd/base-actions` (`reusable-validate.yml`): validação do PR (lint apenas como aviso) e auditoria de dependências, nível `high` bloqueante |
| `Security Scan` (`security.yml`) | Gitleaks via `juninmd/base-actions` (`reusable-security-scan.yml`), em push para `main`/`master` |
| `Release Drafter` (`release-drafter.yml`) | Mantém o rascunho de release atualizado; não bloqueia |

## ✅ Homologação

Última rodada (Chromium do Playwright, headless, com a extensão carregada): **111 testes unitários + 24 e2e passando** (+4 unitários e 1 e2e contra as APIs reais com `LIVE=1`). No Windows use `CHROME_PATH` apontando para o Chromium do Playwright.

**Lotes reais** (leilão 8120, lotes 3, 4 e 8, página de detalhe, APIs FIPE reais, 3 execuções completas): 87 verificações, todas OK. Cobrem lance/comissão/despesas lidos da própria página, aritmética do detalhamento e do lance máximo recalculada de forma independente, ausência de deriva em 10 s, resultado idêntico em contexto novo, seletor (pré-preenchimento, busca, teclado, categoria, Esc) em 1280 px e 375 px. Dois defeitos só apareceram aí e estão cobertos por teste: "Despesas **operacionais**" (o site usa essa palavra em alguns leilões) e a extensão ler o próprio painel como lance quando o lote não tem lances ("Aguardando lances": vale o *Lance Inicial*). Firefox: `web-ext lint` com 0 erros.

**Cache, alertas e "Meu lote" em lotes reais** (lotes 1, 2, 3, 4, 6 e 8 do leilão 8120, APIs FIPE reais): 38 verificações, todas OK. Cobrem a tabela de referência real aprendida, respostas gravadas e etiquetadas com ela, contador do popup igual às requisições reais, **revisita dos 3 lotes com 0 chamadas à API**, favorito/alvo/anotação que sobrevivem ao recarregar, lucro e lance máximo com revenda e meta recalculados de forma independente. Dois falsos positivos só apareceram nas páginas reais e estão cobertos por teste: o aviso que o Freitas repete em todos os lotes ("sinistros já ocorridos em qualquer classificação de monta", inclusive a variante que termina uma lista de substantivos) fazia **todo lote** ganhar o chip "Sinistro".

---
Licença ISC.
