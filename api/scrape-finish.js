import { cors, requireEnv, scoreAndSaveLeads } from './_lib.js';

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

// POST { datasetId, baseId, tableId, businessProfile, countryCode? }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['APIFY_KEY', 'AIRTABLE_TOKEN', 'ANTHROPIC_API_KEY']);
    const { datasetId, baseId, tableId, businessProfile, countryCode } = req.body || {};
    if (!datasetId || !baseId || !tableId || !businessProfile) {
      return res.status(400).json({ error: 'datasetId, baseId, tableId e businessProfile são obrigatórios' });
    }

    let items = await fetchDataset(datasetId);
    if (countryCode) {
      items = items.filter((it) => (it.countryCode || '').toUpperCase() === countryCode);
    }
    const leads = items.map(mapLead).filter((l) => l.empresa);
    if (!leads.length) return res.status(200).json({ saved: 0, message: 'Nenhum lead encontrado.' });

    const result = await scoreAndSaveLeads(baseId, tableId, businessProfile, leads);
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
