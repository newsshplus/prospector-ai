import { cors, requireEnv, makeSessionToken } from './_lib.js';

// POST { password } → login. DELETE → logout.
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'pai_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    return res.status(200).json({ loggedOut: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['APP_PASSWORD']);
    const { password } = req.body || {};
    if (!password || password !== process.env.APP_PASSWORD) {
      return res.status(401).json({ error: 'Password incorreta.' });
    }
    const token = makeSessionToken();
    res.setHeader(
      'Set-Cookie',
      `pai_session=${token}; Path=/; Max-Age=${60 * 60 * 24 * 7}; HttpOnly; SameSite=Lax; Secure`
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
