import { cors, requireEnv, requireAuth, scoreAndSaveLeads } from './_lib.js';

function cleanPhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d+]/g, '');
}

async function fetchDataset(datasetId) {
  const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_KEY}`);
  if (!r.ok) throw new Error(`Apify dataset falhou: ${r.status} ${await r.text()}`);
  return r.json();
}

function mapLead(item) {
  const cat = item.categoryName || item.category || (Array.isArray(item.categories) ? item.categories[0] : '') || '';
  return {
    empresa: (item.title || '').trim(),
    website: item.website || '',
    telefone: cleanPhone(item.phoneUnformatted || item.phone || ''),
    categoria: cat,
    endereco: item.address || '',
    cidade: item.city || '',
    googleMaps: item.url || '',
    rating: item.totalScore ?? null,
    reviews: item.reviewsCount ?? null,
  };
}

// POST modo Apify: { datasetId, baseId, tableId, businessProfile, countryCode? }
// POST modo fallback (DuckDuckGo/Google CSE): { leads, baseId, tableId, businessProfile }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    requireEnv(['AIRTABLE_TOKEN', 'ANTHROPIC_API_KEY']);
    const { datasetId, leads: providedLeads, baseId, tableId, businessProfile, countryCode } = req.body || {};
    if (!baseId || !tableId || !businessProfile) {
      return res.status(400).json({ error: 'baseId, tableId e businessProfile são obrigatórios' });
    }

    let leads;
    if (providedLeads) {
      // modo fallback: leads já vêm prontos do DuckDuckGo/Google CSE
      leads = providedLeads;
    } else if (datasetId) {
      // modo Apify: busca o dataset e mapeia
      requireEnv(['APIFY_KEY']);
      let items = await fetchDataset(datasetId);
      if (countryCode) {
        items = items.filter((it) => (it.countryCode || '').toUpperCase() === countryCode);
      }
      leads = items.map(mapLead).filter((l) => l.empresa);
    } else {
      return res.status(400).json({ error: 'É preciso fornecer datasetId (modo Apify) ou leads (modo fallback)' });
    }

    if (!leads.length) return res.status(200).json({ saved: 0, message: 'Nenhum lead encontrado.' });

    const result = await scoreAndSaveLeads(baseId, tableId, businessProfile, leads);
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
