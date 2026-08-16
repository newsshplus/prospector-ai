import { cors, requireEnv, requireAuth } from './_lib.js';

// GET ?runId=...
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    requireAuth(req);
    requireEnv(['APIFY_KEY']);
    const { runId } = req.query;
    if (!runId) return res.status(400).json({ error: 'runId é obrigatório' });

    const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_KEY}`);
    if (!r.ok) throw new Error(`Apify falhou: ${r.status} ${await r.text()}`);
    const { data } = await r.json();

    res.status(200).json({
      status: data.status,
      itemCount: data.stats?.itemCount || 0,
      datasetId: data.defaultDatasetId,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
