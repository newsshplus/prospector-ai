import { cors, requireEnv, callClaude, parseJsonLoose } from './_lib.js';

const SYSTEM = `És um estratega sénior de go-to-market B2B.
Recebes apenas o perfil de um negócio (site, descrição, ICP) e uma localização-alvo — sem nicho definido.

A tua missão:
1. Identifica as 3 maiores dores que este negócio resolve para os seus clientes.
2. A partir dessas dores, identifica os 5 melhores nichos comerciais para prospectar na localização indicada — nichos com necessidade clara deste tipo de serviço E capacidade financeira razoável para o pagar. Não escolhas nichos genéricos demais ("empresas" não é um nicho); sê específico (ex: "clínicas dentárias", "escritórios de advocacia imobiliária").
3. Para cada nicho, escreve uma justificação curta (1 frase) de porque é um bom encaixe, e sugere o termo de pesquisa exato a usar no scraping (ex: "clínicas dentárias em Cascais").

Sé honesto: se a descrição do negócio for vaga ou genérica, di-lo e sugere ao utilizador que refine o perfil (passo 1 do painel) em vez de inventar nichos plausíveis sem fundamento real.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "dores": [string, string, string],
  "nichos": [
    {"nicho": string, "justificacao": string, "queryPesquisa": string}
    ... exatamente 5
  ],
  "aviso": string | null (usa isto só se a descrição do negócio for demasiado vaga para uma análise fiável)
}
Escreve tudo em português europeu (PT-PT), sem brasileirismos.`;

function buildPrompt(businessProfile, localizacao) {
  return `PERFIL DO NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LOCALIZAÇÃO-ALVO: ${localizacao}

Responde só com o objeto JSON.`;
}

// POST { businessProfile, localizacao }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['ANTHROPIC_API_KEY']);
    const { businessProfile, localizacao } = req.body || {};
    if (!businessProfile || !localizacao) {
      return res.status(400).json({ error: 'businessProfile e localizacao são obrigatórios' });
    }
    if (!businessProfile.descricao || businessProfile.descricao.trim().length < 15) {
      return res.status(400).json({ error: 'Preenche uma descrição mais detalhada do negócio no passo 1 antes de descobrir nichos.' });
    }

    const text = await callClaude({ system: SYSTEM, prompt: buildPrompt(businessProfile, localizacao), maxTokens: 2000 });
    const result = parseJsonLoose(text);

    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
