import { cors, airtableHeaders, requireEnv, requireAuth, BASE_FIELDS } from './_lib.js';

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
        tables: [{ name: 'Leads', fields: BASE_FIELDS }],
      }),
    });
    if (!r.ok) throw new Error(`Airtable falhou ao criar base: ${r.status} ${await r.text()}`);
    const data = await r.json();

    res.status(200).json({ baseId: data.id, tableId: data.tables[0].id, name });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
