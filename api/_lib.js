// Helpers partilhados pelas funções serverless. Sem dependências externas.

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function airtableList(baseId, tableId) {
  let records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, { headers: airtableHeaders() });
    if (!r.ok) throw new Error(`Airtable list falhou: ${r.status} ${await r.text()}`);
    const data = await r.json();
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

export async function airtableCreateRecords(baseId, tableId, fieldsArray) {
  const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
  const created = [];
  for (let i = 0; i < fieldsArray.length; i += 10) {
    const batch = fieldsArray.slice(i, i + 10).map((fields) => ({ fields }));
    const r = await fetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({ records: batch }),
    });
    if (!r.ok) throw new Error(`Airtable create falhou: ${r.status} ${await r.text()}`);
    const data = await r.json();
    created.push(...data.records);
  }
  return created;
}

export async function airtableUpdateRecord(baseId, tableId, recordId, fields) {
  const url = `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: airtableHeaders(),
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Airtable update falhou: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function callClaude({ system, prompt, maxTokens = 2000, webSearch = false }) {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Claude API falhou: ${r.status} ${await r.text()}`);
  const data = await r.json();
  // Com web_search pode haver vários blocos de texto intercalados com pesquisas — juntamos todos.
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// --- Deteção de tech stack via fetch direto ao site (sem depender da IA) ---

const TECH_SIGNATURES = [
  { name: 'Meta Pixel', re: /connect\.facebook\.net\/.+\/fbevents\.js|fbq\(\s*['"]init['"]/i },
  { name: 'Google Analytics / GA4', re: /gtag\(\s*['"]config['"]|google-analytics\.com\/analytics\.js|googletagmanager\.com\/gtag\/js/i },
  { name: 'Google Tag Manager', re: /googletagmanager\.com\/gtm\.js/i },
  { name: 'WordPress', re: /wp-content|wp-includes/i },
  { name: 'Shopify', re: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: 'Wix', re: /static\.wixstatic\.com|wix\.com\/website/i },
  { name: 'Squarespace', re: /squarespace\.com|static1\.squarespace\.com/i },
  { name: 'Webflow', re: /assets-global\.website-files\.com|webflow\.com/i },
  { name: 'HubSpot', re: /js\.hs-scripts\.com|hs-analytics\.net|hubspot\.com/i },
  { name: 'Intercom', re: /widget\.intercom\.io/i },
  { name: 'Tawk.to', re: /embed\.tawk\.to/i },
  { name: 'RD Station', re: /d335luupugsy2\.cloudfront\.net|rdstation/i },
  { name: 'ActiveCampaign', re: /activehosted\.com/i },
  { name: 'Widget WhatsApp', re: /wa\.me\/|api\.whatsapp\.com/i },
];

export async function detectTechStack(websiteUrl) {
  if (!websiteUrl) return { detected: [], fetched: false };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
    const r = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!r.ok) return { detected: [], fetched: false };
    const html = await r.text();
    const detected = TECH_SIGNATURES.filter((t) => t.re.test(html)).map((t) => t.name);
    return { detected, fetched: true };
  } catch {
    return { detected: [], fetched: false };
  }
}

// --- Gestão dinâmica de campos Airtable (para atualizar bases criadas antes de novos módulos) ---

export async function airtableEnsureFields(baseId, tableId, desiredFields) {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: airtableHeaders() });
  if (!r.ok) throw new Error(`Airtable schema falhou: ${r.status} ${await r.text()}`);
  const { tables } = await r.json();
  const table = tables.find((t) => t.id === tableId);
  if (!table) throw new Error('Tabela não encontrada na base.');
  const existingNames = new Set(table.fields.map((f) => f.name));

  for (const field of desiredFields) {
    if (existingNames.has(field.name)) continue;
    const fr = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields`, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify(field),
    });
    if (!fr.ok) {
      // não bloqueia o resto do fluxo por um campo que falhe (ex: já existe com outro tipo)
      console.error('Falha ao criar campo', field.name, await fr.text());
    }
  }
}

// --- Fontes de scraping de fallback (quando o Apify falha/está indisponível) ---

const SKIP_DOMAINS = /facebook\.com|instagram\.com|linkedin\.com|yelp\.|tripadvisor\.|wikipedia\.org|youtube\.com|pagesamarelas\.pt|maps\.google|twitter\.com|x\.com|indeed\.com|glassdoor\./i;

export async function scrapeDuckDuckGo(niche, zone, maxResults) {
  const cheerio = await import('cheerio');
  const query = `${niche} ${zone}`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProspectorAI/1.0)' } });
  if (!r.ok) return [];
  const html = await r.text();
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('.result__body').each((_, el) => {
    if (results.length >= maxResults) return;
    const titleEl = $(el).find('.result__a').first();
    const title = titleEl.text().trim();
    let href = titleEl.attr('href') || '';
    const m = href.match(/uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (!title || !href) return;
    let domain;
    try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch { return; }
    if (SKIP_DOMAINS.test(domain) || seen.has(domain)) return;
    seen.add(domain);
    results.push({
      empresa: title,
      website: href,
      telefone: '',
      categoria: '',
      endereco: '',
      cidade: zone,
      googleMaps: '',
      rating: null,
      reviews: null,
    });
  });
  return results;
}

// Nota: a Custom Search JSON API da Google está fechada a novos registos desde 2025
// e será totalmente descontinuada em 1 jan 2027. Só funciona aqui se já tiveres
// GOOGLE_CSE_KEY/GOOGLE_CSE_CX de um projeto Google Cloud criado antes disso.
export async function scrapeGoogleCSE(niche, zone, maxResults) {
  if (!process.env.GOOGLE_CSE_KEY || !process.env.GOOGLE_CSE_CX) return [];
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', process.env.GOOGLE_CSE_KEY);
  url.searchParams.set('cx', process.env.GOOGLE_CSE_CX);
  url.searchParams.set('q', `${niche} ${zone}`);
  url.searchParams.set('num', String(Math.min(maxResults, 10)));
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || [])
    .filter((item) => { try { return !SKIP_DOMAINS.test(new URL(item.link).hostname); } catch { return false; } })
    .map((item) => ({
      empresa: item.title,
      website: item.link,
      telefone: '',
      categoria: '',
      endereco: '',
      cidade: zone,
      googleMaps: '',
      rating: null,
      reviews: null,
    }));
}

// --- Pontuação ICP (Claude) + gravação em lote no Airtable — partilhado por todos os modos de scraping ---

const ICP_SYSTEM = `És um analista sénior de qualificação de leads B2B (ICP Match Engine).
Recebes o perfil do negócio do utilizador e uma lista de empresas encontradas no mercado.
Para CADA empresa, calcula um ICP score e classifica-a.
Responde APENAS com um array JSON válido, sem texto antes ou depois, sem markdown.
Formato de cada item: {"index": number, "score": number (0-100), "classificacao": "Score A - Hot" | "Score B - Warm" | "Score C - Cold", "dor": string (1 frase, a dor/gap real que o serviço do utilizador resolve), "proximaAcao": string (1 frase, ex: "Contactar via WhatsApp esta semana")}.
Critérios: Score A (85-100) = gaps claros que o serviço resolve imediatamente, boa maturidade digital/orçamental. Score B (60-84) = perfil ideal mas sem dor urgente explícita. Score C (<60) = fora do segmento ou sem potencial — ainda assim inclui no array.
Escreve "dor" e "proximaAcao" em português europeu (PT-PT), sem brasileirismos.`;

async function scoreBatchWithClaude(businessProfile, leads) {
  const prompt = `PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

EMPRESAS ENCONTRADAS (array, usa o "index" de cada uma na tua resposta):
${JSON.stringify(leads.map((l, i) => ({ index: i, ...l })), null, 2)}

Responde só com o array JSON.`;
  const text = await callClaude({ system: ICP_SYSTEM, prompt, maxTokens: 4000 });
  return parseJsonLoose(text);
}

export async function scoreAndSaveLeads(baseId, tableId, businessProfile, leads) {
  if (!leads.length) return { saved: 0, total: 0 };

  const scored = [];
  const BATCH = 15;
  for (let i = 0; i < leads.length; i += BATCH) {
    const chunk = leads.slice(i, i + BATCH);
    const results = await scoreBatchWithClaude(businessProfile, chunk);
    for (const r of results) {
      const lead = chunk[r.index];
      if (lead) scored.push({ ...lead, ...r });
    }
  }

  const records = scored.map((s) => ({
    Empresa: s.empresa,
    Website: s.website || undefined,
    Telefone: s.telefone || undefined,
    'ICP Score': s.score,
    Classificação: s.classificacao,
    'Dor Identificada': s.dor,
    'Próxima Ação': s.proximaAcao,
    'Google Maps': s.googleMaps || undefined,
    Rating: s.rating ?? undefined,
    Reviews: s.reviews ?? undefined,
    Status: 'Novo',
  }));

  const created = await airtableCreateRecords(baseId, tableId, records);
  return { saved: created.length, total: leads.length };
}

// --- Verificação técnica de entregabilidade de email (MX / SPF / DMARC / DKIM best-effort) ---

const DKIM_COMMON_SELECTORS = ['google', 'selector1', 'selector2', 'k1', 'mandrill', 'everlytickey1', 'default'];

export async function checkEmailDeliverability(email) {
  const result = { email, syntaxOk: false, domain: null, mx: false, spf: false, dmarc: false, dkimSelectorFound: null, notes: [] };
  if (!email) return result;

  const syntaxRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  result.syntaxOk = syntaxRe.test(email);
  if (!result.syntaxOk) {
    result.notes.push('Sintaxe de email inválida.');
    return result;
  }

  const domain = email.split('@')[1];
  result.domain = domain;

  const dns = await import('node:dns/promises');

  try {
    const mx = await dns.resolveMx(domain);
    result.mx = mx.length > 0;
    if (!result.mx) result.notes.push('Sem registos MX — domínio provavelmente não recebe email.');
  } catch {
    result.notes.push('Não foi possível resolver registos MX (domínio pode não existir).');
  }

  try {
    const txt = await dns.resolveTxt(domain);
    const flat = txt.map((t) => t.join(''));
    result.spf = flat.some((t) => t.toLowerCase().startsWith('v=spf1'));
    if (!result.spf) result.notes.push('Sem registo SPF encontrado no domínio.');
  } catch {
    result.notes.push('Não foi possível verificar SPF.');
  }

  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`);
    const flat = txt.map((t) => t.join(''));
    result.dmarc = flat.some((t) => t.toLowerCase().startsWith('v=dmarc1'));
    if (!result.dmarc) result.notes.push('Sem registo DMARC encontrado.');
  } catch {
    result.notes.push('Sem registo DMARC encontrado (_dmarc ausente).');
  }

  // DKIM: verificação best-effort por seletores comuns. A ausência aqui NÃO prova que o DKIM
  // não está configurado — a maioria dos seletores reais são específicos do ESP e não são adivinháveis.
  for (const selector of DKIM_COMMON_SELECTORS) {
    try {
      const txt = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
      if (txt.length) {
        result.dkimSelectorFound = selector;
        break;
      }
    } catch {
      // tenta o próximo seletor
    }
  }
  if (!result.dkimSelectorFound) {
    result.notes.push('DKIM não confirmado (verificação por seletores comuns, não é conclusiva).');
  }

  return result;
}

// --- Estatísticas reais do pipeline para o relatório executivo (tudo calculado a partir de dados reais no Airtable, nunca inventado) ---

export function computeReportStats(leads, custoMensal) {
  const total = leads.length;
  const byStatus = {};
  const byClassificacao = {};
  const byPrioridade = {};
  const techFreq = {};
  let icpSum = 0, icpCount = 0;
  let intentSum = 0, intentCount = 0;
  let enrichedCount = 0, outreachCount = 0, cadenceCount = 0;
  let ganhoCount = 0, ganhoValorTotal = 0, perdidoCount = 0;

  const meetingOrWonStatuses = new Set(['Reunião Agendada', 'Fechado - Ganho']);
  const classifMeetingCounts = {};
  const classifTotalCounts = {};
  const techMeetingCounts = {};
  const techTotalCounts = {};

  for (const l of leads) {
    const status = l.Status || 'Novo';
    byStatus[status] = (byStatus[status] || 0) + 1;

    const classif = l['Classificação'] || 'Sem classificação';
    byClassificacao[classif] = (byClassificacao[classif] || 0) + 1;
    classifTotalCounts[classif] = (classifTotalCounts[classif] || 0) + 1;
    if (meetingOrWonStatuses.has(status)) classifMeetingCounts[classif] = (classifMeetingCounts[classif] || 0) + 1;

    const prio = l['Prioridade de Disparo'];
    if (prio) byPrioridade[prio] = (byPrioridade[prio] || 0) + 1;

    if (typeof l['ICP Score'] === 'number') { icpSum += l['ICP Score']; icpCount++; }
    if (typeof l['Intent Score'] === 'number') { intentSum += l['Intent Score']; intentCount++; }

    if (l['Techs Utilizadas']) {
      enrichedCount++;
      const techs = String(l['Techs Utilizadas']).split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of techs) {
        techFreq[t] = (techFreq[t] || 0) + 1;
        techTotalCounts[t] = (techTotalCounts[t] || 0) + 1;
        if (meetingOrWonStatuses.has(status)) techMeetingCounts[t] = (techMeetingCounts[t] || 0) + 1;
      }
    }
    if (l['WhatsApp Msg 1'] || l['Email Corpo']) outreachCount++;
    if (l['Cadência 21 Dias']) cadenceCount++;

    const resultado = l['Resultado Final'];
    if (resultado === 'Fechado - Ganho') {
      ganhoCount++;
      if (typeof l['Valor do Negócio'] === 'number') ganhoValorTotal += l['Valor do Negócio'];
    } else if (resultado === 'Fechado - Perdido') {
      perdidoCount++;
    }
  }

  const classifConversion = Object.keys(classifTotalCounts).map((c) => ({
    classificacao: c,
    total: classifTotalCounts[c],
    reunioesOuGanhos: classifMeetingCounts[c] || 0,
    taxa: classifTotalCounts[c] ? Math.round(((classifMeetingCounts[c] || 0) / classifTotalCounts[c]) * 100) : 0,
  }));

  const techConversion = Object.keys(techTotalCounts)
    .filter((t) => techTotalCounts[t] >= 3) // amostra mínima para não tirar conclusões de 1-2 casos
    .map((t) => ({
      tech: t,
      total: techTotalCounts[t],
      reunioesOuGanhos: techMeetingCounts[t] || 0,
      taxa: Math.round(((techMeetingCounts[t] || 0) / techTotalCounts[t]) * 100),
    }))
    .sort((a, b) => b.taxa - a.taxa)
    .slice(0, 5);

  const roi = custoMensal && ganhoValorTotal > 0
    ? Math.round(((ganhoValorTotal - custoMensal) / custoMensal) * 100)
    : null;
  const cpl = custoMensal && total > 0 ? Math.round((custoMensal / total) * 100) / 100 : null;

  return {
    totalLeads: total,
    porStatus: byStatus,
    porClassificacao: byClassificacao,
    porPrioridade: byPrioridade,
    icpScoreMedio: icpCount ? Math.round((icpSum / icpCount) * 10) / 10 : null,
    intentScoreMedio: intentCount ? Math.round((intentSum / intentCount) * 10) / 10 : null,
    percentEnriquecido: total ? Math.round((enrichedCount / total) * 100) : 0,
    percentComAbordagemGerada: total ? Math.round((outreachCount / total) * 100) : 0,
    percentComCadenciaGerada: total ? Math.round((cadenceCount / total) * 100) : 0,
    negociosGanhos: ganhoCount,
    negociosPerdidos: perdidoCount,
    valorTotalGanho: ganhoValorTotal || null,
    conversaoPorClassificacao: classifConversion,
    topTechPorConversao: techConversion,
    roiPercent: roi,
    custoPorLead: cpl,
    custoMensalInformado: custoMensal || null,
    dadosInsuficientesPara: [
      ...(custoMensal ? [] : ['CPL', 'ROI (falta custo mensal)']),
      ...(ganhoValorTotal > 0 ? [] : ['ROI (nenhum negócio com "Valor do Negócio" preenchido e Resultado Final = Fechado - Ganho)']),
      'Taxa de entrega de Email/WhatsApp (o sistema não envia mensagens automaticamente, não há dados de entrega/abertura)',
      'Taxa de resposta por variação de mensagem (não há registo de qual variante foi enviada a cada lead)',
    ],
  };
}

export function parseJsonLoose(text) {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    const err = new Error(`Variáveis de ambiente em falta: ${missing.join(', ')}`);
    err.status = 500;
    throw err;
  }
}
