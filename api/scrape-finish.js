import { cors, requireEnv, airtableCreateRecords, callClaude, parseJsonLoose } from './_lib.js';

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

const SYSTEM = `És um analista sénior de qualificação de leads B2B (ICP Match Engine).
Recebes o perfil do negócio do utilizador e uma lista de empresas encontradas no mercado.
Para CADA empresa, calcula um ICP score e classifica-a.
Responde APENAS com um array JSON válido, sem texto antes ou depois, sem markdown.
Formato de cada item: {"index": number, "score": number (0-100), "classificacao": "Score A - Hot" | "Score B - Warm" | "Score C - Cold", "dor": string (1 frase, a dor/gap real que o serviço do utilizador resolve), "proximaAcao": string (1 frase, ex: "Contactar via WhatsApp esta semana")}.
Critérios: Score A (85-100) = gaps claros que o serviço resolve imediatamente, boa maturidade digital/orçamental. Score B (60-84) = perfil ideal mas sem dor urgente explícita. Score C (<60) = fora do segmento ou sem potencial — ainda assim inclui no array.
Escreve "dor" e "proximaAcao" em português europeu (PT-PT), sem brasileirismos.`;

async function scoreBatch(businessProfile, leads) {
  const prompt = `PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

EMPRESAS ENCONTRADAS (array, usa o "index" de cada uma na tua resposta):
${JSON.stringify(leads.map((l, i) => ({ index: i, ...l })), null, 2)}

Responde só com o array JSON.`;
  const text = await callClaude({ system: SYSTEM, prompt, maxTokens: 4000 });
  return parseJsonLoose(text);
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
    let leads = items.map(mapLead).filter((l) => l.empresa);
    if (!leads.length) return res.status(200).json({ saved: 0, message: 'Nenhum lead encontrado.' });

    // Pontuar em lotes de 15 para manter os prompts pequenos
    const scored = [];
    const BATCH = 15;
    for (let i = 0; i < leads.length; i += BATCH) {
      const chunk = leads.slice(i, i + BATCH);
      const results = await scoreBatch(businessProfile, chunk);
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
    res.status(200).json({ saved: created.length, total: leads.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
