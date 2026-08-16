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
  geocodeZone,
  currencyForCountry,
  currencyLabel,
  dispatchWebhook,
  buildWhatsAppPayload,
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
  "budget": string (estimativa de orçamento em faixa, NA MOEDA LOCAL INDICADA, sempre rotulado como estimativa, nunca como facto confirmado),
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
  const moeda = lead.Moeda || 'EUR (€)';

  const prompt = `PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD (dados brutos da raspagem):
${JSON.stringify(lead, null, 2)}

MOEDA LOCAL DESTE LEAD: ${moeda} — usa esta moeda na estimativa de orçamento.

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
// Considera TODOS os serviços descritos no perfil (não só um ângulo) e sugere
// ticket médio estimado na moeda local do mercado-alvo.
// ==================================================================
const DISCOVER_SYSTEM = `És um estratega sénior de go-to-market B2B.
Recebes o perfil de um negócio (site, descrição — que pode cobrir VÁRIOS serviços/linhas de trabalho diferentes) e uma localização-alvo — sem nicho definido.

A tua missão:
1. Lê a descrição do negócio como um todo — se o negócio oferece vários serviços diferentes, considera-os TODOS ao procurares nichos, não te fixes só no primeiro serviço mencionado.
2. Identifica as 3 maiores dores que este negócio resolve (no conjunto dos seus serviços).
3. Identifica os 5 melhores nichos comerciais para prospectar na localização indicada — combina dois critérios: (a) alta probabilidade de conversão (dor clara + urgência plausível) e (b) ticket médio bom para o teu negócio. Não escolhas nichos genéricos demais ("empresas" não é um nicho); sê específico.
4. Para cada nicho, dá: uma justificação curta (1 frase), o termo de pesquisa exato a usar no scraping, e uma estimativa de ticket médio mensal/pontual que esse nicho normalmente paga por este tipo de serviço — SEMPRE na moeda local indicada, sempre rotulada como estimativa.
5. Ordena os 5 nichos do melhor para o pior (considerando conversão + ticket).

Sê honesto: se a descrição do negócio for vaga ou genérica, di-lo e sugere ao utilizador que refine o perfil (passo 1 do painel) em vez de inventar nichos plausíveis sem fundamento real. Nunca inventes números de ticket como se fossem dados de mercado confirmados — são sempre estimativas informadas.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "dores": [string, string, string],
  "nichos": [
    {"nicho": string, "justificacao": string, "queryPesquisa": string, "ticketMedioEstimado": string, "rank": number}
    ... exatamente 5, rank de 1 (melhor) a 5
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

  const geo = await geocodeZone(localizacao);
  const moeda = currencyLabel(geo.countryCode);

  const prompt = `PERFIL DO NEGÓCIO (pode ter vários serviços — considera todos):
${JSON.stringify(businessProfile, null, 2)}

LOCALIZAÇÃO-ALVO: ${localizacao}
MOEDA LOCAL DESTE MERCADO: ${moeda}

Responde só com o objeto JSON.`;

  const text = await callAI({ system: DISCOVER_SYSTEM, prompt, maxTokens: 2500 });
  const result = parseJsonLoose(text);
  result.moeda = moeda;
  result.countryCode = geo.countryCode || null;
  if (Array.isArray(result.nichos)) {
    result.nichos.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  }
  return result;
}

// ==================================================================
// type: "liveAssist" — Copiloto quase-em-tempo-real para chamada/WhatsApp (texto puro → Groq primeiro, latência baixa)
// Não é escuta contínua de áudio — recebe um trecho de texto (digitado, colado, ou transcrito de um
// áudio curto) e devolve uma sugestão de resposta imediata para o agente humano usar.
// ==================================================================
const LIVE_ASSIST_SYSTEM = `És um copiloto de vendas B2B que assiste um agente humano EM TEMPO REAL durante uma chamada ou conversa de WhatsApp.
Recebes a última mensagem/frase do lead (pode vir de texto escrito ou de uma transcrição de áudio, por isso pode ter imperfeições de transcrição — interpreta com bom senso), o histórico recente da conversa se existir, e o contexto do lead/negócio.

A tua resposta tem de ser CURTA e IMEDIATAMENTE UTILIZÁVEL — o agente vai lê-la e usá-la em segundos, não é para ler um ensaio.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "leituraDaSituacao": string (1 frase curta: o que o lead está a sinalizar — interesse, objeção, dúvida, desinteresse, etc.),
  "respostaSugerida": string (a frase ou 2 frases exatas que o agente pode dizer/escrever agora, no idioma pedido, tom natural),
  "proximoPasso": string (1 frase: o que fazer a seguir depois desta resposta)
}
Nunca sugere afirmações falsas sobre o produto/serviço ou a concorrência. Se a mensagem do lead for ambígua, a leituraDaSituacao deve dizer isso em vez de assumir.`;

async function runLiveAssist(body) {
  const { mensagemRecebida, historico, lead, businessProfile, idioma = DEFAULT_IDIOMA } = body;
  if (!mensagemRecebida || !businessProfile) throw badRequest('mensagemRecebida e businessProfile são obrigatórios');

  const prompt = `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

${lead ? `LEAD:\n${JSON.stringify(lead, null, 2)}\n\n` : ''}${historico ? `HISTÓRICO RECENTE DA CONVERSA:\n${historico}\n\n` : ''}ÚLTIMA MENSAGEM DO LEAD (texto ou transcrição de áudio):
"${mensagemRecebida}"

Responde só com o objeto JSON.`;

  const text = await callAI({ system: LIVE_ASSIST_SYSTEM, prompt, maxTokens: 800 });
  return parseJsonLoose(text);
}

// ==================================================================
// type: "crmSend" — Envia lead + análises completas para o teu CRM (webhook genérico)
// e, opcionalmente, dispara o envio de WhatsApp (Evolution API/Evolution Go/Z-API) e email
// através dos teus próprios webhooks (n8n/Make à frente do teu CRM/provedor).
// ==================================================================
async function runCrmSend(body) {
  const { lead, businessProfile, analise, targets } = body;
  if (!lead || !targets) throw badRequest('lead e targets são obrigatórios');

  const resultados = {};

  if (targets.crmWebhookUrl) {
    const headers = targets.crmSecretToken ? { 'x-webhook-token': targets.crmSecretToken } : {};
    resultados.crm = await dispatchWebhook(targets.crmWebhookUrl, {
      evento: 'lead.enviado',
      timestamp: new Date().toISOString(),
      lead,
      businessProfile,
      analise: analise || null,
    }, headers);
  }

  if (targets.whatsappWebhookUrl) {
    const phone = lead.Telefone || lead.telefone || '';
    const mensagem = (analise && (analise.whatsapp1 || analise.whatsappVariacoes?.[0])) || lead['WhatsApp Msg 1'] || '';
    if (!phone) {
      resultados.whatsapp = { ok: false, error: 'Lead sem telefone/WhatsApp registado.' };
    } else if (!mensagem) {
      resultados.whatsapp = { ok: false, error: 'Sem mensagem de WhatsApp gerada para este lead ainda — usa "Abordagens" ou "Qualidade" primeiro.' };
    } else {
      resultados.whatsapp = await dispatchWebhook(
        targets.whatsappWebhookUrl,
        buildWhatsAppPayload(targets.whatsappProvider || 'evolution', phone, mensagem)
      );
    }
  }

  if (targets.emailWebhookUrl) {
    const email = lead.Email || lead.email || '';
    const assunto = (analise && analise.emailAssunto) || lead['Email Assunto'] || `Contacto — ${lead.Empresa || lead.empresa || ''}`;
    const corpo = (analise && (analise.emailCorpo || analise.emailPlainText)) || lead['Email Corpo'] || '';
    if (!email) {
      resultados.email = { ok: false, error: 'Lead sem email registado.' };
    } else if (!corpo) {
      resultados.email = { ok: false, error: 'Sem email gerado para este lead ainda — usa "Abordagens" ou "Qualidade" primeiro.' };
    } else {
      resultados.email = await dispatchWebhook(targets.emailWebhookUrl, { to: email, subject: assunto, text: corpo });
    }
  }

  return { resultados };
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
  liveAssist: runLiveAssist,
  crmSend: runCrmSend,
};

// POST { type, ...resto conforme o type acima }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    const { type } = req.body || {};
    const run = HANDLERS[type];
    if (!run) return res.status(400).json({ error: `type inválido. Usa um de: ${Object.keys(HANDLERS).join(', ')}` });
    // "enrich" precisa sempre da Claude (pesquisa web). Os restantes tentam a Groq primeiro
    // e só usam a Claude como rede de segurança — por isso não exigimos ANTHROPIC_API_KEY aqui;
    // callAI() dá um erro claro em runtime se não houver Groq nem Claude configurados.
    if (type === 'enrich') requireEnv(['ANTHROPIC_API_KEY']);

    const result = await run(req.body);
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
