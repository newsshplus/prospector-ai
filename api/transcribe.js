import { cors, requireAuth, requireEnv } from './_lib.js';

// Transcrição de um clipe de áudio curto (não é streaming contínuo — grava/carrega um trecho,
// transcreve, e o resultado alimenta o "liveAssist" em /api/ai). Usa a Whisper da Groq (rápida e
// dentro das chaves já configuradas) — se não houver chave Groq, devolve erro claro.

function getGroqKeys() {
  return [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
}

// POST { audioBase64, mimeType, idioma? }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireAuth(req);
    const keys = getGroqKeys();
    if (!keys.length) {
      const err = new Error('Transcrição de áudio precisa de pelo menos uma GROQ_API_KEY configurada.');
      err.status = 500;
      throw err;
    }

    const { audioBase64, mimeType = 'audio/webm' } = req.body || {};
    if (!audioBase64) return res.status(400).json({ error: 'audioBase64 é obrigatório' });

    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : mimeType.includes('m4a') ? 'm4a' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `clip.${ext}`);
    form.append('model', 'whisper-large-v3-turbo');

    let lastErr;
    for (const key of keys.sort(() => Math.random() - 0.5)) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
        if (!r.ok) {
          lastErr = new Error(`Groq Whisper falhou: ${r.status} ${await r.text()}`);
          continue;
        }
        const data = await r.json();
        return res.status(200).json({ transcript: data.text || '' });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Transcrição falhou em todas as chaves Groq.');
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
