import { cors, requireEnv, airtableList } from './_lib.js';

// GET ?baseId=...&tableId=...
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    requireEnv(['AIRTABLE_TOKEN']);
    const { baseId, tableId } = req.query;
    if (!baseId || !tableId) return res.status(400).json({ error: 'baseId e tableId são obrigatórios' });

    const records = await airtableList(baseId, tableId);
    res.status(200).json({
      leads: records.map((r) => ({ id: r.id, ...r.fields })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
