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

export async function callClaude({ system, prompt, maxTokens = 2000 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API falhou: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
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
