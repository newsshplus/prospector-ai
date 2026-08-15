# Prospector AI

Sistema web de prospecção B2B: scraping de leads (Google Maps via Apify) → ICP score com IA → geração de abordagens omnichannel (WhatsApp, Email, script de ligação) → gravado num pipeline em Airtable.

Sem framework nem build step: `index.html` estático + funções serverless em `/api` (Node, zero dependências). Pensado para deploy direto no Vercel.

## Variáveis de ambiente necessárias (Vercel → Project → Settings → Environment Variables)

| Variável | Onde obter |
|---|---|
| `APIFY_KEY` | apify.com → Account → Integrations → API token |
| `AIRTABLE_TOKEN` | airtable.com/create/tokens — scopes: `data.records:read`, `data.records:write`, `schema.bases:write`, `schema.bases:read` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

Depois de adicionar as variáveis, faz um redeploy (Vercel → Deployments → ⋯ → Redeploy).

## Primeiro uso

1. Abre o site.
2. **Passo 1** — preenche o perfil do teu negócio (URL, descrição, ICP) e guarda.
3. **Passo 2** — clica "Criar base nova" para o sistema criar automaticamente uma base Airtable com o schema completo (Empresa, ICP Score, Classificação, Dor Identificada, mensagens geradas, etc.). Ou cola o Base ID / Table ID de uma base já existente.
4. **Passo 3** — preenche nicho + zona (ex: "clínicas dentárias" + "Cascais, Portugal") e clica "Iniciar scraping". O sistema faz scraping no Google Maps, pontua cada lead com IA (Score A/B/C) e grava tudo no Airtable.
5. Na tabela de pipeline, clica **"Gerar abordagens"** em qualquer lead para gerar WhatsApp (2 versões), email (assunto + corpo) e script de ligação — tudo já gravado no Airtable e com payloads prontos para webhooks (Z-API/Evolution, Resend/SendGrid, HubSpot/Pipedrive) que podes ligar diretamente ao teu n8n.

O perfil do negócio e o Base/Table ID ficam guardados no `localStorage` do browser (não há login/multi-utilizador nesta v1).

## Limitações da v1 (próximos passos sugeridos)

- **Cadeia de fallback de scraping** (primário Apify → secundário DuckDuckGo → terciário Google Custom Search):
  - O **DuckDuckGo é grátis e não precisa de chave**, mas devolve menos campos que o Apify (sem telefone, rating, reviews — só empresa + website, a partir de resultados de pesquisa web).
  - A **Bing Search API foi totalmente descontinuada pela Microsoft em 11 de agosto de 2025** — não existe alternativa gratuita da Microsoft hoje, por isso não está implementada.
  - A **Google Custom Search JSON API está fechada a novos registos desde 2025** e será descontinuada em 1 de janeiro de 2027 — só funciona aqui se já tiveres `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` de um projeto Google Cloud criado antes do fecho. Se não tiveres, o sistema salta este passo automaticamente.
  - Quando o Apify falha (chave em falta, rate limit, erro), o sistema cai automaticamente para o DuckDuckGo sem intervenção manual.
- Sem autenticação — qualquer pessoa com o URL do deploy consegue usar o painel. Para produção, adicionar Vercel Authentication ou uma password simples no frontend.
- Filtragem por país é opcional e best-effort (via geocoding), e só se aplica ao caminho do Apify.
- ICP scoring é feito em lotes de 15 leads por chamada à API da Claude, para manter os prompts pequenos.

## Variáveis de ambiente opcionais (fallback de scraping)

| Variável | Necessária para |
|---|---|
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Terciário — só se já tiveres um projeto Google Custom Search existente |

## Estrutura

```
index.html              → dashboard (frontend, sem build)
api/airtable-init.js     → cria a base Airtable com o schema completo
api/scrape-start.js      → inicia o scraping (Apify → fallback DuckDuckGo → fallback Google CSE)
api/scrape-status.js     → consulta o estado do scraping (modo Apify)
api/scrape-finish.js     → busca resultados do Apify, pontua com IA, grava no Airtable
api/scrape-finish-sync.js → pontua com IA e grava leads vindos do fallback (DuckDuckGo/Google)
api/leads.js             → lista os leads da base para o dashboard
api/outreach.js          → gera WhatsApp/Email/script de ligação para um lead
api/_lib.js              → helpers partilhados (Airtable, Claude API)
```
