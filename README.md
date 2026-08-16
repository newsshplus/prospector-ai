# Prospector AI

Sistema web de prospecção B2B: descoberta de nicho (sem obrigar a escolher um só, a IA lê todos os teus serviços e sugere os 5 melhores nichos ordenados por conversão + ticket) → scraping de leads (Google Maps via Apify, com fallback DuckDuckGo/Google CSE) → ICP score com IA → enriquecimento BANT+ → geração de abordagens omnichannel (WhatsApp, Email, script de ligação, cadência de 21 dias, roteiro anti-objeção) → **copiloto de venda quase-em-tempo-real** (texto ou clipe de áudio curto) → relatório executivo → **envio para o teu próprio CRM/WhatsApp/Email via webhook** → tudo gravado num pipeline em Airtable.

Sem framework nem build step: `index.html` estático + funções serverless em `/api` (Node). Pensado para deploy direto no Vercel, plano Hobby (grátis).

## Segurança: painel com login

O painel está protegido por password — é preciso porque cada ação consome créditos pagos de IA (Claude, e opcionalmente Groq). Não há multi-utilizador nem gestão de contas nesta v1: é uma única password partilhada, guardada como variável de ambiente, nunca no código.

A sessão fica num cookie `httpOnly` assinado (HMAC-SHA256, 7 dias de validade) — não há biblioteca externa nem base de dados de sessões.

## Poupança de tokens: Groq primeiro, Claude só quando necessário

Para tarefas de texto puro (ICP score, WhatsApp, email, objeções, cadência, descoberta de nicho, relatório, copiloto ao vivo), o sistema tenta primeiro a **Groq** (grátis, com rotação entre até 3 chaves e 2 modelos — se uma chave atingir o limite, tenta a seguinte automaticamente) e só usa a **Claude** como rede de segurança se a Groq falhar.

A única tarefa que usa sempre a Claude diretamente é o **Enriquecimento BANT+** (botão "Enriquecer"), porque precisa da ferramenta de pesquisa web da Claude para investigar o decisor-chave e sinais de urgência — a Groq não tem essa ferramenta embutida.

## Descoberta de nicho sem obrigatoriedade — e por ticket médio

Não precisas de indicar um nicho manualmente. No passo 3, escreves só a localização-alvo e clicas "Descobrir nichos automaticamente": a IA lê **todos** os serviços descritos no teu perfil (não só o primeiro que aparece no texto), identifica as 3 maiores dores que resolves, e sugere 5 nichos ordenados do melhor para o pior — o critério combina probabilidade de conversão **e** ticket médio esperado nesse nicho, sempre expresso na moeda local (ver abaixo). Podes usar o nicho recomendado nº1 diretamente ou escolher outro da lista.

## Moeda automática por país

Quando fazes uma prospecção ou descobres nichos numa localização, o sistema deteta o país (via geocoding) e usa a moeda local em todas as estimativas de ticket/orçamento — Portugal/Espanha/França/Itália/Alemanha → EUR, Brasil → BRL, Suíça → CHF, Reino Unido → GBP, Estados Unidos → USD, México/Argentina/Colômbia/Chile/Peru/Uruguai → moeda local respetiva, Angola → AOA, Moçambique → MZN, Cabo Verde → CVE. Por defeito assume EUR se o país não for reconhecido. Cada lead grava a moeda detetada no campo "Moeda" do Airtable, e o enriquecimento BANT+ usa-a na estimativa de orçamento.

## Copiloto de venda quase-em-tempo-real

Botão **"🎧 Copiloto"** em cada lead: cola ou escreve a última frase que o lead disse (numa chamada ou WhatsApp) e recebe em segundos uma leitura da situação, a resposta sugerida (pronta a dizer/escrever) e o próximo passo — usando a Groq para latência baixa.

**Sobre áudio — nota honesta:** isto não é escuta contínua de uma chamada ao vivo (essa infraestrutura de streaming/telefonia não existe nesta stack de site estático + funções serverless gratuitas). O que existe é: gravas ou carregas um clipe de áudio curto (ex: um apontamento de voz feito durante ou logo a seguir à chamada), o sistema transcreve-o com a Whisper da Groq, e o texto alimenta o copiloto. É "quase tempo real" por lotes curtos, não streaming contínuo.

## Envio para o teu CRM / WhatsApp / Email (webhook de saída)

Na secção de configuração, define os URLs de webhook do teu CRM, do teu provedor de WhatsApp (Evolution API / Evolution Go / Z-API) e/ou de email — são simples endpoints POST que a tua automação (n8n/Make) já deve ter, à frente do CRM que uses ("próprio CRM" ou outro). Em cada lead, o botão **"📤 Enviar para CRM"** dispara os webhooks configurados com um payload consolidado (dados do lead + todas as análises geradas: BANT+, mensagens, roteiro de objeções, cadência). Não há documentação oficial de nenhum CRM específico aqui — o payload é genérico e bem estruturado; adapta o mapeamento de campos na tua automação, tal como já fazes com outras ferramentas do teu stack.

## Variáveis de ambiente (Vercel → Project → Settings → Environment Variables)

### Obrigatórias

| Variável | Onde obter |
|---|---|
| `APP_PASSWORD` | Escolhe tu — é a password para entrar no painel. Não a partilhes no chat comigo nem em nenhum sítio público. |
| `APIFY_KEY` | apify.com → Account → Integrations → API token |
| `AIRTABLE_TOKEN` | airtable.com/create/tokens — scopes: `data.records:read`, `data.records:write`, `schema.bases:write`, `schema.bases:read` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

### Opcionais (mas recomendadas para poupar tokens da Claude e ativar o copiloto de áudio)

| Variável | Para quê |
|---|---|
| `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3` | Até 3 chaves da Groq (console.groq.com → API Keys). Com pelo menos uma preenchida, o sistema tenta a Groq primeiro em quase todas as tarefas de texto, e ativa a transcrição de áudio do copiloto (Whisper). Sem nenhuma, usa sempre a Claude e o copiloto de áudio fica desativado (só texto). |
| `SESSION_SECRET` | Segredo para assinar o cookie de sessão. Se não definires, o sistema usa o `APP_PASSWORD` como segredo (funciona, mas é mais seguro teres um segredo à parte). |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Fallback terciário de scraping — só funciona com uma chave já existente de antes de 2025 (ver limitações abaixo). |

Depois de adicionar/alterar variáveis, faz sempre um redeploy (Vercel → Deployments → ⋯ → Redeploy).

Os webhooks de CRM/WhatsApp/Email **não** são variáveis de ambiente — configuras os URLs diretamente no painel (ficam no `localStorage` do browser), porque podes querer trocar de automação sem fazer redeploy.

## Primeiro uso

1. Abre o site — vais ver a tela de login. Entra com o `APP_PASSWORD` que definiste.
2. **Passo 1** — preenche o perfil do teu negócio (URL, descrição de todos os serviços, ICP) e guarda.
3. **Passo 2** — clica "Criar base nova" para criar automaticamente uma base Airtable com o schema completo. Ou cola o Base ID / Table ID de uma base já existente.
4. **Passo 3** — preenche a localização e clica "🔍 Descobrir nichos automaticamente" para a IA sugerir 5 nichos (ordenados por conversão + ticket, na moeda local), ou preenche nicho + zona manualmente. Clica "Iniciar scraping".
5. Na tabela de pipeline, cada lead tem: **Enriquecer** (BANT+ com pesquisa web), **Abordagens** (WhatsApp/email/script), **Qualidade** (variações + verificação de email), **Objeções** (roteiro de chamada), **Cadência 21d** (follow-up omnichannel), **🎧 Copiloto** (sugestão de resposta quase-em-tempo-real), **📤 Enviar para CRM** (webhooks). No topo da tabela, **📊 Relatório CRO** mostra métricas reais do pipeline.

O perfil do negócio, o Base/Table ID e os URLs de webhook ficam guardados no `localStorage` do browser. A sessão de login fica num cookie do servidor.

## Limitações da v1 (próximos passos sugeridos)

- **Login é de password única partilhada** — não há gestão de utilizadores nem convites.
- **Copiloto não é streaming de áudio contínuo** — funciona por clipes curtos carregados/transcritos, não por escuta ao vivo de uma chamada em curso (essa infraestrutura de telefonia não existe nesta stack).
- **Webhook de CRM é genérico** — sem documentação oficial de um CRM específico chamado "Pitro" ou outro, o payload é uma estrutura bem pensada mas não garantidamente compatível campo-a-campo; passa pela tua automação (n8n/Make) para mapear.
- **Cadeia de fallback de scraping** (primário Apify → secundário DuckDuckGo → terciário Google Custom Search):
  - O **DuckDuckGo é grátis e não precisa de chave**, mas devolve menos campos que o Apify.
  - A **Bing Search API foi totalmente descontinuada pela Microsoft em 11 de agosto de 2025** — não está implementada.
  - A **Google Custom Search JSON API está fechada a novos registos desde 2025** — só funciona com uma chave já existente de antes disso.
- Filtragem por país é opcional e best-effort (via geocoding), e só se aplica ao caminho do Apify.
- ICP scoring é feito em lotes de 15 leads por chamada à IA, para manter os prompts pequenos.
- Lista de moedas por país cobre os mercados mais prováveis do teu negócio (Portugal, Espanha, Brasil, Suíça, e vizinhos) — países fora dessa lista assumem EUR por defeito.

## Estrutura

```
index.html              → dashboard + tela de login (frontend, sem build)
api/auth.js              → login (POST) e logout (DELETE) — cookie de sessão assinado
api/ai.js                → endpoint único para enrich/outreach/objections/cadence/deliverability/
                            discoverNiches/liveAssist/crmSend (consolidado para caber no limite
                            de 12 funções do plano Hobby)
api/transcribe.js        → transcreve um clipe de áudio curto (Whisper via Groq) para o copiloto
api/airtable-init.js     → cria a base Airtable com o schema completo
api/scrape-start.js      → inicia o scraping (Apify → fallback DuckDuckGo → fallback Google CSE)
api/scrape-status.js     → consulta o estado do scraping (modo Apify)
api/scrape-finish.js     → pontua leads com IA e grava no Airtable, com moeda local (modo Apify ou fallback)
api/leads.js             → lista os leads da base para o dashboard
api/report.js            → relatório executivo com métricas reais do pipeline
api/_lib.js              → helpers partilhados (Airtable, Claude API, Groq API, moeda/país,
                            webhooks de saída, sessão/auth)
```

Isto totaliza 9 funções serverless — o plano Hobby da Vercel permite até 12, por isso ainda há margem para futuras adições.
