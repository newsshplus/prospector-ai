import { cors, requireEnv } from './_lib.js';

const ACTOR_ID = 'nwua9Gu5YrADL7ZDj'; // compass/crawler-google-places

async function geocodeZone(zone) {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', zone);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '1');
    const r = await fetch(url, { headers: { 'User-Agent': 'prospector-ai/1.0' } });
    if (!r.ok) return {};
    const results = await r.json();
    if (results[0]) {
      return {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon),
        countryCode: (results[0].address?.country_code || '').toUpperCase(),
      };
    }
  } catch {
    // segue sem coordenadas
  }
  return {};
}

// POST { niche, zone, maxResults }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['APIFY_KEY']);
    const { niche, zone, maxResults = 60 } = req.body || {};
    if (!niche || !zone) return res.status(400).json({ error: 'niche e zone são obrigatórios' });

    const { lat, lng, countryCode } = await geocodeZone(zone);

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
    if (lat) {
      payload.lat = lat;
      payload.lng = lng;
      payload.zoom = 12;
    }

    const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${process.env.APIFY_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`Apify falhou: ${r.status} ${await r.text()}`);
    const data = await r.json();

    res.status(200).json({ runId: data.data.id, countryCode: countryCode || null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
