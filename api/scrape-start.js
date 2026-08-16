import { cors, requireEnv, requireAuth, geocodeZone, scrapeRapidApiLocalBusiness, scrapeDuckDuckGo, scrapeGoogleCSE } from './_lib.js';

const ACTOR_ID = 'nwua9Gu5YrADL7ZDj'; // compass/crawler-google-places

// SECUNDÁRIO: Apify (Google Maps, assíncrono). Lança erro se a chave faltar ou o pedido falhar,
// para o handler principal poder cair para os fallbacks seguintes.
async function tryApify(niche, zone, maxResults, geo) {
  requireEnv(['APIFY_KEY']);
  const payload = {
    searchStringsArray: [`${niche} em ${zone}`],
    maxCrawledPlaces: maxResults,
    language: 'pt',
    maxImages: 0,
    maxReviews: 0,
    includeHistogram: false,
    includeOpeningHours: false,
    includeWebResults: false,
  };
  if (geo.lat) {
    payload.lat = geo.lat;
    payload.lng = geo.lng;
    payload.zoom = 12;
  }

  const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${process.env.APIFY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Apify falhou: ${r.status} ${await r.text()}`);
  const data = await r.json();

  return { runId: data.data.id };
}

// POST { niche, zone, maxResults }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    const { niche, zone, maxResults = 60 } = req.body || {};
    if (!niche || !zone) return res.status(400).json({ error: 'niche e zone são obrigatórios' });

    // Geocodifica sempre primeiro — dá-nos o país (para a moeda local e para o idioma/região
    // corretos no RapidAPI) independentemente de qual fonte de scraping acabar a ser usada.
    const geo = await geocodeZone(zone);
    const countryCode = geo.countryCode || null;

    // PRIMÁRIA: RapidAPI "Local Business Data" — síncrona (sem polling), e devolve email/redes
    // sociais quando disponíveis, o que dá à Groq mais contexto real para o ICP scoring.
    try {
      const leads = await scrapeRapidApiLocalBusiness(niche, zone, maxResults, countryCode);
      if (leads.length) {
        return res.status(200).json({ mode: 'sync', leads, source: 'rapidapi', countryCode });
      }
      console.error('RapidAPI (Local Business Data) devolveu 0 resultados, a tentar Apify.');
    } catch (rapidErr) {
      console.error('RapidAPI indisponível, a tentar Apify:', rapidErr.message);
    }

    // SECUNDÁRIA: Apify (assíncrono)
    try {
      const { runId } = await tryApify(niche, zone, maxResults, geo);
      return res.status(200).json({ mode: 'async', runId, countryCode });
    } catch (apifyErr) {
      console.error('Apify indisponível, a tentar fallback:', apifyErr.message);
    }

    // TERCIÁRIA: DuckDuckGo HTML (grátis, sem chave necessária)
    let leads = await scrapeDuckDuckGo(niche, zone, maxResults);
    let source = 'duckduckgo';

    // QUATERNÁRIA: Google Custom Search — só funciona com uma chave já existente
    // (a API está fechada a novos registos desde 2025)
    if (!leads.length) {
      leads = await scrapeGoogleCSE(niche, zone, maxResults);
      source = 'google_cse';
    }

    if (!leads.length) {
      return res.status(502).json({
        error: 'Nenhuma fonte de scraping (RapidAPI, Apify, DuckDuckGo, Google) devolveu resultados. Verifica as chaves configuradas ou tenta um nicho/zona diferente.',
      });
    }

    res.status(200).json({ mode: 'sync', leads, source, countryCode });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
