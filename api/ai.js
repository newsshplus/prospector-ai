import {
  cors,
  requireEnv,
  requireAuth,
  callAI,
  callClaude,
  parseJsonLoose,
  detectTechStack,
  checkEmailDeliverability,
  airtableEnsureFields,
  airtableUpdateRecord,
} from './_lib.js';

const DEFAULT_IDIOMA = 'Português de Portugal (PT-PT)';

// ==================================================================
// type: "enrich" — Deep BANT+ & Tech-Stack Enricher (precisa de pesquisa web → sempre Claude)
// ==================================================================
const ENRICH_FIELDS = [
  { name: 'Cargo', type: 'singleLineText' },
  { name: 'Techs Utilizadas', type: 'multilineText' },
  { name: 'Fator de Urgência', type: 'multilineText' },
  { name: 'Budget Estimado', type: 'singleLineText' },
  { name: 'Intent Score', type: 'number', options: { precision: 0 } },
  {
    name: 'Prioridade de Disparo',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'Alta - Disparo imediato', color: 'redBright' },
        { name: 'Média - Fila padrão', color: 'yellowBright' },
        { name: 'Desqualificado', color: 'grayBright' },
      ],
    },
  },
];

const ENRICH_SYSTEM = `És o "Deep BANT & Tech-Stack Enricher", um agente de inteligência de prospecção B2B.
Recebes o perfil do negócio do utilizador, os dados brutos de um lead (empresa encontrada numa raspagem) e a tech stack já detetada tecnicamente no site dele.
Usa a ferramenta de pesquisa web para investigar: quem é o decisor-chave (CEO/CMO/CTO/Diretor de Operações — nome e cargo, via LinkedIn ou site institucional), sinais de urgência (vagas abertas no LinkedIn, expansão recente, notícias, tecnologia visivelmente desatualizada) e contexto de dimensão da empresa (nº de colaboradores, presença online) para estimar orçamento.

Depois de pesquisares, responde APENAS com um objeto JSON válido (sem markdown, sem texto antes/depois) com esta forma exata:
{
  "cargo": string (cargo do decisor-chave encontrado, ou "Não identificado"),
  "decisorChave": string (nome do decisor-chave, ou "Não identificado"),
  "budget": string (estimativa de orçamento em faixa, ex: "500-1500€/mês", sempre rotulado como estimativa, nunca como facto confirmado),
  "authority": string (1 frase sobre a estrutura de decisão encontrada),
  "need": [string, string, string] (exatamente 3 falhas operacionais/estéticas/tecnológicas reais e específicas encontradas),
  "timeline": string (1 frase resumindo o indicador de urgência mais forte encontrado, ou "Sem sinais de urgência identificados"),
  "techStack": [string] (lista de tecnologias detetadas, combina as já fornecidas com o que encontrares),
  "intentScore": number (0-100, segue a matriz: >80 alta prioridade, 50-79 média, <50 desqualificado),
  "prioridade": "Alta - Disparo imediato" | "Média - Fila padrão" | "Desqualificado"
}
Sê honesto sobre incerteza: se não encontrares um decisor ou sinal de urgência, di-lo explicitamente em vez de inventar. Escreve tudo em português europeu (PT-PT), sem brasileirismos.`;

async function runEnrich(body) {
  const { lead, businessProfile, baseId, tableId, recordId } = body;
  if (!lead || !businessProfile) throw badRequest('lead e businessProfile são obrigatórios');

  const website = lead.Website || lead.website;
  const { detected: techDetected } = await detectTechStack(website);

  const prompt = `PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD (dados brutos da raspagem):
${JSON.stringify(lead, null, 2)}

TECH STACK JÁ DETETADA TECNICAMENTE NO SITE (via análise do HTML, confiança alta):
${techDetected.length ? techDetected.join(', ') : 'Nenhuma detetada automaticamente — investiga via pesquisa web.'}

Investiga o decisor-chave, sinais de urgência (BANT+) e confirma/complementa a tech stack. Responde só com o objeto JSON.`;

  const text = await callClaude({ system: ENRICH_SYSTEM, prompt, maxTokens: 3000, webSearch: true });
  const enrichment = parseJsonLoose(text);
  const techStack = Array.from(new Set([...(techDetected || []), ...(enrichment.techStack || [])]));
  enrichment.techStack = techStack;

  if (baseId && tableId && recordId) {
    await airtableEnsureFields(baseId, tableId, ENRICH_FIELDS);
    await airtableUpdateRecord(baseId, tableId, recordId, {
      Cargo: enrichment.cargo,
      Decisor: enrichment.decisorChave,
      'Techs Utilizadas': techStack.join(', '),
      'Fator de Urgência': enrichment.timeline,
      'Budget Estimado': enrichment.budget,
      'Intent Score': enrichment.intentScore,
      'Prioridade de Disparo': enrichment.prioridade,
      'Dor Identificada': Array.isArray(enrichment.need) ? enrichment.need.join(' · ') : enrichment.need,
    });
  }

  return { enrichment };
}

// ==================================================================
// type: "outreach" — WhatsApp/Email/Script de ligação (texto puro → Groq primeiro)
// ==================================================================
const OUTREACH_SYSTEM = `És um copywriter sénior B2B especializado em outbound humano (não soa a IA).
Recebes o perfil do negócio do remetente e os dados de um lead qualificado.
Gera abordagens ultrapersonalizadas com tom 100% humano — nunca uses frases genéricas como
"espero que este email o encontre bem". Baseia-te sempre na dor identificada do lead.
Escreve tudo no idioma pedido (variante indicada). Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "whatsapp1": string (abertura de curiosidade, baseada numa falha/oportunidade real da empresa, tom direto),
  "whatsapp2": string (foco em ROI direto, mais curto, estilo texto/áudio transcrito),
  "emailAssunto": string (hiper-específico, sem soar a spam),
  "emailCorpo": string (estrutura AIDA/PAS, cita o nome do decisor se existir e a dor identificada),
  "scriptLigacao": string (com 3 partes claras: quebra de gelo de 5s, pergunta de ancoragem sobre a dor, pitch de 15s para agendar reunião — separa as partes com quebras de linha)
}`;

function waPayload(lead, message) {
  return {
    descricao: 'Payload para Z-API / Evolution API — adaptar ao endpoint do teu WhatsApp Business',
    endpointExemplo: 'POST {SEU_HOST_ZAPI_OU_EVOLUTION}/send-text',
    body: { phone: lead.Telefone || lead.telefone || '', message },
  };
}
function emailPayload(lead, subject, body) {
  return {
    descricao: 'Payload para Resend / SendGrid',
    endpointExemplo: 'POST https://api.resend.com/emails',
    body: { to: lead.Email || lead.email || '', subject, text: body },
  };
}
function crmPayload(lead, nextAction) {
  return {
    descricao: 'Payload para tarefa no CRM (HubSpot / Pipedrive)',
    body: {
      title: `Ligar para ${lead.Empresa || lead.empresa || ''}`,
      note: nextAction || 'Ligação de qualificação',
      dueInDays: 2,
    },
  };
}

async function runOutreach(body) {
  const { lead, businessProfile, idioma = DEFAULT_IDIOMA, baseId, tableId, recordId } = body;
  if (!lead || !businessProfile) throw badRequest('lead e businessProfile são obrigatórios');

  const prompt = `IDIOMA DA ABORDAGEM: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

Responde só com o objeto JSON.`;

  const text = await callAI({ system: OUTREACH_SYSTEM, prompt, maxTokens: 2000 });
  const msgs = parseJsonLoose(text);

  if (baseId && tableId && recordId) {
    await airtableUpdateRecord(baseId, tableId, recordId, {
      'WhatsApp Msg 1': msgs.whatsapp1,
      'WhatsApp Msg 2': msgs.whatsapp2,
      'Email Assunto': msgs.emailAssunto,
      'Email Corpo': msgs.emailCorpo,
      'Script Ligação': msgs.scriptLigacao,
    });
  }

  return {
    messages: msgs,
    webhookPayloads: {
      whatsapp: waPayload(lead, msgs.whatsapp1),
      email: emailPayload(lead, msgs.emailAssunto, msgs.emailCorpo),
      crm: crmPayload(lead, msgs.proximaAcao),
    },
  };
}

// ==================================================================
// type: "objections" — Roteiro anti-objeção (texto puro → Groq primeiro)
// ==================================================================
const OBJ_FIELDS = [{ name: 'Roteiro Anti-Objeção', type: 'multilineText' }];
const OBJECOES_BASE = [
  'Já tenho uma agência/fornecedor que faz isso.',
  'Envia-me uma proposta por email.',
  'Não temos orçamento neste momento.',
  'Não tenho tempo para falar agora.',
  'Não tenho interesse.',
];
const OBJ_SYSTEM = `És um treinador sénior de vendas B2B, especialista em lidar com objeções em chamadas a frio e trocas de mensagens.
Recebes o perfil do negócio do utilizador e os dados de um lead específico (incluindo a dor/gap já identificado, se existir).
Para CADA uma das 5 objeções clássicas fornecidas, escreve a resposta ideal:
- Máximo 3 frases.
- Tom empático mas assertivo, focado em valor real, nunca agressivo ou manipulador.
- Sempre que possível, ancora a resposta num detalhe concreto e real do lead (a dor identificada, a tech stack, o site) em vez de genérico — se não houver detalhe concreto disponível, usa um argumento de valor geral honesto em vez de inventar factos sobre a empresa.
- Nunca incentives a fazer afirmações falsas sobre o produto/serviço do utilizador ou sobre a concorrência.

Escreve também 2 frases de fecho para transitar diretamente da conversa para o agendamento de uma reunião no calendário.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "objecoes": [{"objecao": string, "resposta": string}, ... (uma entrada por cada objeção recebida, pela mesma ordem)],
  "fechamento": [string, string]
}
Escreve tudo no idioma pedido.`;

async function runObjections(body) {
  const { lead, businessProfile, idioma = DEFAULT_IDIOMA, baseId, tableId, recordId } = body;
  if (!lead || !businessProfile) throw badRequest('lead e businessProfile são obrigatórios');

  const prompt = `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

OBJEÇÕES CLÁSSICAS A RESPONDER (pela mesma ordem):
${OBJECOES_BASE.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Responde só com o objeto JSON.`;

  const text = await callAI({ system: OBJ_SYSTEM, prompt, maxTokens: 2000 });
  const result = parseJsonLoose(text);

  if (baseId && tableId && recordId) {
    await airtableEnsureFields(baseId, tableId, OBJ_FIELDS);
    const readable = result.objecoes.map((o) => `Objeção: ${o.objecao}\nResposta: ${o.resposta}`).join('\n\n')
      + `\n\nFecho 1: ${result.fechamento[0]}\nFecho 2: ${result.fechamento[1]}`;
    await airtableUpdateRecord(baseId, tableId, recordId, { 'Roteiro Anti-Objeção': readable });
  }

  return result;
}

// ==================================================================
// type: "cadence" — Cadência de 21 dias (texto puro → Groq primeiro)
// ==================================================================
const CADENCE_FIELDS = [{ name: 'Cadência 21 Dias', type: 'multilineText' }];
const CADENCE_SYSTEM = `És o estratega de cadências de outbound B2B omnichannel.
Recebes o perfil do negócio do utilizador e os dados de um lead que não respondeu ao primeiro contacto.
Gera o conteúdo completo de uma cadência de 21 dias com este mapa temporal fixo (não alteres os dias nem os canais):

- Dia 1: WhatsApp (quebra de padrão, curioso, não genérico) + Email #1 (estrutura AIDA, valor direto).
- Dia 3: Email #2 (prova social / caso de referência do mesmo nicho).
- Dia 5: Ligação telefónica (abertura curta de 3 frases — o roteiro completo de objeções é gerado noutro módulo, aqui só a abertura) + WhatsApp de lembrete ("tentei ligar...").
- Dia 8: Email #3 (conteúdo educativo / insight de mercado relevante para o nicho do lead).
- Dia 12: WhatsApp (pergunta direta de sim/não, muito curta).
- Dia 16: Email #4 (última tentativa de valor, sem pressão).
- Dia 21: Email de despedida ("breakup email" — tom leve, sem culpa, deixa a porta aberta).

Regras obrigatórias:
- O tom varia genuinamente entre toques — nunca repete a mesma estrutura de frase.
- No Dia 3 (prova social): NUNCA inventes um nome de cliente, empresa ou testemunho específico. Se o perfil do negócio do utilizador não fornecer um caso real, usa uma referência genérica e honesta (ex: "empresas do mesmo setor que trabalhámos" sem citar nomes ou números inventados) — nunca apresentes um caso fabricado como se fosse real.
- No Dia 8 (conteúdo educativo): o insight tem de ser genuinamente útil e específico ao nicho do lead, não genérico.
- Todas as mensagens devem soar humanas, nunca a IA ou a template automático.
- Escreve tudo no idioma pedido, português europeu por defeito, sem brasileirismos.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "cadencia": [
    {"dia": 1, "canais": ["whatsapp","email"], "whatsapp": string, "emailAssunto": string, "emailCorpo": string},
    {"dia": 3, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 5, "canais": ["ligacao","whatsapp"], "roteiroLigacao": string, "whatsapp": string},
    {"dia": 8, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 12, "canais": ["whatsapp"], "whatsapp": string},
    {"dia": 16, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 21, "canais": ["email"], "emailAssunto": string, "emailCorpo": string}
  ]
}`;

function crmStopTaskPayload(lead) {
  return {
    descricao: 'Payload de exemplo para a tarefa de CRM a criar quando o lead responder em qualquer canal — a regra de paragem em si tem de ser implementada no teu workflow n8n (ouvir respostas inbound de WhatsApp/Email e cancelar os envios agendados desta cadência).',
    body: {
      title: 'LEAD RESPONDEU — ASSUMIR ATENDIMENTO HUMANO',
      lead: lead.Empresa || lead.empresa || '',
      acao: 'Parar imediatamente todos os toques agendados desta cadência e passar para atendimento humano.',
    },
  };
}

async function runCadence(body) {
  const { lead, businessProfile, idioma = DEFAULT_IDIOMA, baseId, tableId, recordId } = body;
  if (!lead || !businessProfile) throw badRequest('lead e businessProfile são obrigatórios');

  const prompt = `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

Responde só com o objeto JSON.`;

  const text = await callAI({ system: CADENCE_SYSTEM, prompt, maxTokens: 4000 });
  const result = parseJsonLoose(text);

  if (baseId && tableId && recordId) {
    await airtableEnsureFields(baseId, tableId, CADENCE_FIELDS);
    const readable = result.cadencia
      .map((t) => {
        const lines = [`Dia ${t.dia} (${t.canais.join(' + ')})`];
        if (t.whatsapp) lines.push(`WhatsApp: ${t.whatsapp}`);
        if (t.roteiroLigacao) lines.push(`Ligação: ${t.roteiroLigacao}`);
        if (t.emailAssunto) lines.push(`Email — ${t.emailAssunto}\n${t.emailCorpo}`);
        return lines.join('\n');
      })
      .join('\n\n---\n\n');
    await airtableUpdateRecord(baseId, tableId, recordId, { 'Cadência 21 Dias': readable });
  }

  return {
    cadencia: result.cadencia,
    regraParagem: {
      descricao: 'Se o lead responder em QUALQUER canal, interromper imediatamente os toques seguintes e criar tarefa no CRM.',
      crmPayload: crmStopTaskPayload(lead),
    },
  };
}

// ==================================================================
// type: "deliverability" — Qualidade & Entregabilidade (texto puro → Groq primeiro; verificação DNS é local)
// ==================================================================
const DELIV_FIELDS = [
  { name: 'WhatsApp Var 3', type: 'multilineText' },
  { name: 'Verificação Email', type: 'multilineText' },
];
const SPAM_TRIGGERS = [
  'grátis', 'gratis', 'ganhe dinheiro', 'promoção', 'promocao', 'oportunidade única', 'oportunidade unica',
  'clique aqui', 'link abaixo', 'desconto', 'compre já', 'compre ja', 'garantido a 100%', '100% garantido',
  'última chance', 'ultima chance', 'não perca', 'nao perca', 'urgente', 'oferta imperdível', 'oferta imperdivel',
];
function scanTriggers(text) {
  const lower = (text || '').toLowerCase();
  return SPAM_TRIGGERS.filter((t) => lower.includes(t));
}
const DELIV_SYSTEM = `És um especialista em qualidade e entregabilidade de outbound B2B (WhatsApp e Email).
A tua função é escrever variações de alta qualidade que soam genuinamente humanas e evitam linguagem que ativa filtros de spam — não para contornar sistemas de proteção das plataformas, mas porque linguagem exageradamente promocional reduz taxas de resposta e é normalmente sinalizada como spam por qualquer filtro (WhatsApp, Gmail, Outlook).

Regras obrigatórias:
1. Gera 3 variações da mensagem de WhatsApp para o lead. As variações devem ter aberturas, ângulos e fechos genuinamente diferentes entre si — não parafraseia trivialmente a mesma frase.
2. Usa parágrafos curtos com quebras de linha naturais (como alguém escreveria mesmo no telemóvel), tom profissional e conversacional, no idioma pedido.
3. NUNCA uses estas palavras/frases: grátis, ganhe dinheiro, promoção, oportunidade única, clique aqui, link abaixo, desconto, compre já, garantido a 100%, última chance, não perca, urgente, oferta imperdível.
4. Gera também a versão de email em texto simples (plain text): sem HTML, sem imagens, sem botões, parágrafos curtos, assinatura profissional simples de 2-3 linhas — otimizada para caixa de entrada principal em vez de promoções/spam.
Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "whatsappVariacoes": [string, string, string],
  "emailPlainText": string
}`;

async function runDeliverability(body) {
  const { lead, businessProfile, idioma = DEFAULT_IDIOMA, baseId, tableId, recordId } = body;
  if (!lead || !businessProfile) throw badRequest('lead e businessProfile são obrigatórios');

  const email = lead.Email || lead.email;
  const prompt = `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

Responde só com o objeto JSON.`;

  const [text, emailCheck] = await Promise.all([
    callAI({ system: DELIV_SYSTEM, prompt, maxTokens: 2500 }),
    checkEmailDeliverability(email),
  ]);
  const generated = parseJsonLoose(text);

  const avisos = [];
  generated.whatsappVariacoes.forEach((v, i) => {
    const hits = scanTriggers(v);
    if (hits.length) avisos.push(`Variação WhatsApp ${i + 1} contém termo(s) a rever: ${hits.join(', ')}`);
  });
  const emailHits = scanTriggers(generated.emailPlainText);
  if (emailHits.length) avisos.push(`Email contém termo(s) a rever: ${emailHits.join(', ')}`);

  if (baseId && tableId && recordId) {
    await airtableEnsureFields(baseId, tableId, DELIV_FIELDS);
    const emailSummary = email
      ? `MX: ${emailCheck.mx ? 'OK' : 'em falta'} · SPF: ${emailCheck.spf ? 'OK' : 'em falta'} · DMARC: ${emailCheck.dmarc ? 'OK' : 'em falta'} · DKIM: ${emailCheck.dkimSelectorFound ? 'seletor "' + emailCheck.dkimSelectorFound + '" encontrado' : 'não confirmado (best-effort)'}`
      : 'Sem email no lead para verificar.';
    await airtableUpdateRecord(baseId, tableId, recordId, {
      'WhatsApp Msg 1': generated.whatsappVariacoes[0],
      'WhatsApp Msg 2': generated.whatsappVariacoes[1],
      'WhatsApp Var 3': generated.whatsappVariacoes[2],
      'Email Corpo': generated.emailPlainText,
      'Verificação Email': emailSummary,
    });
  }

  return {
    whatsappVariacoes: generated.whatsappVariacoes,
    emailPlainText: generated.emailPlainText,
    emailCheck,
    avisos,
  };
}

// ==================================================================
// type: "discoverNiches" — Descoberta autónoma de nicho (texto puro → Groq primeiro)
// ==================================================================
const DISCOVER_SYSTEM = `És um estratega sénior de go-to-market B2B.
Recebes apenas o perfil de um negócio (site, descrição, ICP) e uma localização-alvo — sem nicho definido.

A tua missão:
1. Identifica as 3 maiores dores que este negócio resolve para os seus clientes.
2. A partir dessas dores, identifica os 5 melhores nichos comerciais para prospectar na localização indicada — nichos com necessidade clara deste tipo de serviço E capacidade financeira razoável para o pagar. Não escolhas nichos genéricos demais ("empresas" não é um nicho); sê específico (ex: "clínicas dentárias", "escritórios de advocacia imobiliária").
3. Para cada nicho, escreve uma justificação curta (1 frase) de porque é um bom encaixe, e sugere o termo de pesquisa exato a usar no scraping (ex: "clínicas dentárias em Cascais").

Sê honesto: se a descrição do negócio for vaga ou genérica, di-lo e sugere ao utilizador que refine o perfil (passo 1 do painel) em vez de inventar nichos plausíveis sem fundamento real.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "dores": [string, string, string],
  "nichos": [
    {"nicho": string, "justificacao": string, "queryPesquisa": string}
    ... exatamente 5
  ],
  "aviso": string | null (usa isto só se a descrição do negócio for demasiado vaga para uma análise fiável)
}
Escreve tudo em português europeu (PT-PT), sem brasileirismos.`;

async function runDiscoverNiches(body) {
  const { businessProfile, localizacao } = body;
  if (!businessProfile || !localizacao) throw badRequest('businessProfile e localizacao são obrigatórios');
  if (!businessProfile.descricao || businessProfile.descricao.trim().length < 15) {
    throw badRequest('Preenche uma descrição mais detalhada do negócio no passo 1 antes de descobrir nichos.');
  }

  const prompt = `PERFIL DO NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LOCALIZAÇÃO-ALVO: ${localizacao}

Responde só com o objeto JSON.`;

  const text = await callAI({ system: DISCOVER_SYSTEM, prompt, maxTokens: 2000 });
  return parseJsonLoose(text);
}

// ==================================================================
// Router
// ==================================================================
function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

const HANDLERS = {
  enrich: runEnrich,
  outreach: runOutreach,
  objections: runObjections,
  cadence: runCadence,
  deliverability: runDeliverability,
  discoverNiches: runDiscoverNiches,
};

// POST { type, ...resto conforme o type acima }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    requireEnv(['ANTHROPIC_API_KEY']);
    const { type } = req.body || {};
    const run = HANDLERS[type];
    if (!run) return res.status(400).json({ error: `type inválido. Usa um de: ${Object.keys(HANDLERS).join(', ')}` });

    const result = await run(req.body);
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
