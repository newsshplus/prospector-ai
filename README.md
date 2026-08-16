# Prospector AI

Sistema web de prospecção B2B: descoberta de nicho → scraping de leads (Google Maps via Apify) → ICP score com IA → enriquecimento BANT+ → geração de abordagens omnichannel (WhatsApp, Email, script de ligação, cadência de 21 dias, roteiro anti-objeção) → relatório executivo → tudo gravado num pipeline em Airtable.

Sem framework nem build step: `index.html` estático + funções serverless em `/api` (Node). Pensado para deploy direto no Vercel, plano Hobby (grátis).

## Segurança: painel com login

O painel está protegido por password — é preciso porque cada ação consome créditos pagos de IA (Claude, e opcionalmente Groq). Não há multi-utilizador nem gestão de contas nesta v1: é uma única password partilhada, guardada como variável de ambiente, nunca no código.

A sessão fica num cookie `httpOnly` assinado (HMAC-SHA256, 7 dias de validade) — não há biblioteca externa nem base de dados de sessões.

## Poupança de tokens: Groq primeiro, Claude só quando necessário

Para tarefas de texto puro (ICP score, WhatsApp, email, objeções, cadência, descoberta de nicho, relatório), o sistema tenta primeiro a **Groq** (grátis, com rotação entre até 3 chaves e 2 modelos — se uma chave atingir o limite, tenta a seguinte automaticamente) e só usa a **Claude** como rede de segurança se a Groq falhar.

A única tarefa que usa sempre a Claude diretamente é o **Enriquecimento BANT+** (botão "Enriquecer"), porque precisa da ferramenta de pesquisa web da Claude para investigar o decisor-chave e sinais de urgência — a Groq não tem essa ferramenta embutida.

## Variáveis de ambiente (Vercel → Project → Settings → Environment Variables)

### Obrigatórias

| Variável | Onde obter |
|---|---|
| `APP_PASSWORD` | Escolhe tu — é a password para entrar no painel. Não a partilhes no chat comigo nem em nenhum sítio público. |
| `APIFY_KEY` | apify.com → Account → Integrations → API token |
| `AIRTABLE_TOKEN` | airtable.com/create/tokens — scopes: `data.records:read`, `data.records:write`, `schema.bases:write`, `schema.bases:read` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

### Opcionais (mas recomendadas para poupar tokens da Claude)

| Variável | Para quê |
|---|---|
| `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3` | Até 3 chaves da Groq (console.groq.com → API Keys). Com pelo menos uma preenchida, o sistema tenta a Groq primeiro em quase todas as tarefas de texto. Sem nenhuma, usa sempre a Claude. |
| `SESSION_SECRET` | Segredo para assinar o cookie de sessão. Se não definires, o sistema usa o `APP_PASSWORD` como segredo (funciona, mas é mais seguro teres um segredo à parte). |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Fallback terciário de scraping — só funciona com uma chave já existente de antes de 2025 (ver limitações abaixo). |

Depois de adicionar/alterar variáveis, faz sempre um redeploy (Vercel → Deployments → ⋯ → Redeploy).

## Primeiro uso

1. Abre o site — vais ver a tela de login. Entra com o `APP_PASSWORD` que definiste.
2. **Passo 1** — preenche o perfil do teu negócio (URL, descrição, ICP) e guarda.
3. **Passo 2** — clica "Criar base nova" para criar automaticamente uma base Airtable com o schema completo. Ou cola o Base ID / Table ID de uma base já existente.
4. **Passo 3** — preenche a localização e clica "🔍 Descobrir nichos automaticamente" para a IA sugerir 5 nichos a partir do teu perfil, ou preenche nicho + zona manualmente. Clica "Iniciar scraping".
5. Na tabela de pipeline, cada lead tem cinco ações: **Enriquecer** (BANT+ com pesquisa web), **Abordagens** (WhatsApp/email/script), **Qualidade** (variações + verificação de email), **Objeções** (roteiro de chamada), **Cadência 21d** (follow-up omnichannel). No topo da tabela, **📊 Relatório CRO** mostra métricas reais do pipeline.

O perfil do negócio e o Base/Table ID ficam guardados no `localStorage` do browser. A sessão de login fica num cookie do servidor.

## Limitações da v1 (próximos passos sugeridos)

- **Login é de password única partilhada** — não há gestão de utilizadores nem convites. Se precisares de múltiplos acessos com permissões diferentes, é um passo extra.
- **Cadeia de fallback de scraping** (primário Apify → secundário DuckDuckGo → terciário Google Custom Search):
  - O **DuckDuckGo é grátis e não precisa de chave**, mas devolve menos campos que o Apify.
  - A **Bing Search API foi totalmente descontinuada pela Microsoft em 11 de agosto de 2025** — não está implementada.
  - A **Google Custom Search JSON API está fechada a novos registos desde 2025** — só funciona com uma chave já existente de antes disso.
- Filtragem por país é opcional e best-effort (via geocoding), e só se aplica ao caminho do Apify.
- ICP scoring é feito em lotes de 15 leads por chamada à IA, para manter os prompts pequenos.

## Estrutura

```
index.html              → dashboard + tela de login (frontend, sem build)
api/auth.js              → login (POST) e logout (DELETE) — cookie de sessão assinado
api/ai.js                → endpoint único para enrich/outreach/objections/cadence/deliverability/discoverNiches
                            (consolidado para caber no limite de 12 funções do plano Hobby)
api/airtable-init.js     → cria a base Airtable com o schema completo
api/scrape-start.js      → inicia o scraping (Apify → fallback DuckDuckGo → fallback Google CSE)
api/scrape-status.js     → consulta o estado do scraping (modo Apify)
api/scrape-finish.js     → pontua leads com IA e grava no Airtable (modo Apify ou fallback)
api/leads.js             → lista os leads da base para o dashboard
api/report.js            → relatório executivo com métricas reais do pipeline
api/_lib.js              → helpers partilhados (Airtable, Claude API, Groq API, sessão/auth)
```

Isto totaliza 8 funções serverless — o plano Hobby da Vercel permite até 12, por isso há margem para futuras adições.
