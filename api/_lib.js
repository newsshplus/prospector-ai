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
