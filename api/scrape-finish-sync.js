import { cors, requireEnv, scoreAndSaveLeads } from './_lib.js';

// POST { leads, baseId, tableId, businessProfile }
// Usado quando o /api/scrape-start devolveu mode:'sync' (Apify indisponível,
// resultados já vieram do DuckDuckGo ou Google CSE).
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['AIRTABLE_TOKEN', 'ANTHROPIC_API_KEY']);
    const { leads, baseId, tableId, businessProfile } = req.body || {};
    if (!leads || !baseId || !tableId || !businessProfile) {
      return res.status(400).json({ error: 'leads, baseId, tableId e businessProfile são obrigatórios' });
    }

    const result = await scoreAndSaveLeads(baseId, tableId, businessProfile, leads);
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
