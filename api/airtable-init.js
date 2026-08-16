import { cors, airtableHeaders, requireEnv, requireAuth } from './_lib.js';

// POST { workspaceId?, name? }
// Devolve { baseId, tableId }. Se workspaceId não for passado, tenta detetar
// automaticamente a partir das bases existentes do token.

async function detectWorkspaceId() {
  const r = await fetch('https://api.airtable.com/v0/meta/bases', { headers: airtableHeaders() });
  if (!r.ok) throw new Error('Não foi possível listar bases do Airtable.');
  const { bases } = await r.json();
  for (const base of bases || []) {
    const r2 = await fetch(`https://api.airtable.com/v0/meta/bases/${base.id}`, { headers: airtableHeaders() });
    if (r2.ok) {
      const info = await r2.json();
      if (info.workspaceId) return info.workspaceId;
    }
  }
  throw new Error(
    'Não foi possível detetar o workspace automaticamente. Cria uma base vazia no Airtable primeiro, ou passa "workspaceId" no pedido.'
  );
}

const FIELDS = [
  { name: 'Empresa', type: 'singleLineText' },
  { name: 'Website', type: 'url' },
  { name: 'Decisor', type: 'singleLineText' },
  { name: 'Telefone', type: 'phoneNumber' },
  { name: 'Email', type: 'email' },
  { name: 'ICP Score', type: 'number', options: { precision: 0 } },
  {
    name: 'Classificação',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'Score A - Hot', color: 'greenBright' },
        { name: 'Score B - Warm', color: 'yellowBright' },
        { name: 'Score C - Cold', color: 'grayBright' },
      ],
    },
  },
  { name: 'Dor Identificada', type: 'multilineText' },
  { name: 'Próxima Ação', type: 'singleLineText' },
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
  { name: 'WhatsApp Msg 1', type: 'multilineText' },
  { name: 'WhatsApp Msg 2', type: 'multilineText' },
  { name: 'Email Assunto', type: 'singleLineText' },
  { name: 'Email Corpo', type: 'multilineText' },
  { name: 'Script Ligação', type: 'multilineText' },
  { name: 'Google Maps', type: 'url' },
  { name: 'Rating', type: 'number', options: { precision: 1 } },
  { name: 'Reviews', type: 'number', options: { precision: 0 } },
  {
    name: 'Status',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'Novo', color: 'blueBright' },
        { name: 'Contatado', color: 'cyanBright' },
        { name: 'Respondeu', color: 'tealBright' },
        { name: 'Reunião Agendada', color: 'purpleBright' },
        { name: 'Descartado', color: 'redBright' },
      ],
    },
  },
];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    requireEnv(['AIRTABLE_TOKEN']);
    const body = req.body || {};
    const workspaceId = body.workspaceId || (await detectWorkspaceId());
    const name = body.name || 'Prospector AI - Pipeline';

    const r = await fetch('https://api.airtable.com/v0/meta/bases', {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        name,
        workspaceId,
        tables: [{ name: 'Leads', fields: FIELDS }],
      }),
    });
    if (!r.ok) throw new Error(`Airtable falhou ao criar base: ${r.status} ${await r.text()}`);
    const data = await r.json();

    res.status(200).json({ baseId: data.id, tableId: data.tables[0].id, name });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
