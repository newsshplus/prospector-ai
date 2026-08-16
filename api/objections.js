import { cors, requireEnv, callClaude, parseJsonLoose, airtableEnsureFields, airtableUpdateRecord } from './_lib.js';

const OBJ_FIELDS = [
  { name: 'Roteiro Anti-Objeção', type: 'multilineText' },
];

const OBJECOES_BASE = [
  'Já tenho uma agência/fornecedor que faz isso.',
  'Envia-me uma proposta por email.',
  'Não temos orçamento neste momento.',
  'Não tenho tempo para falar agora.',
  'Não tenho interesse.',
];

const SYSTEM = `És um treinador sénior de vendas B2B, especialista em lidar com objeções em chamadas a frio e trocas de mensagens.
Recebes o perfil do negócio do utilizador e os dados de um lead específico (incluindo a dor/gap já identificado, se existir).
Para CADA uma das 5 objeções clássicas fornecidas, escreve a resposta ideal:
- Máximo 3 frases.
- Tom empático mas assertivo, focado em valor real, nunca agressivo ou manipulador.
- Sempre que possível, ancora a resposta num detalhe concreto e real do lead (a dor identificada, a tech stack, o site) em vez de genérico — se não houver detalhe concreto disponível, usa um argumento de valor geral honesto em vez de inventar factos sobre a empresa.
- Nunca incentives a fazer afirmações falsas sobre o produto/serviço do utilizador ou sobre a concorrência.

Escreve também 2 frases de fecho para transitar diretamente da conversa para o agendamento de uma reunião no calendário.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "objecoes": [{"objecao": string, "resposta": string}, ... (uma entrada por cada objeção recebida, pela mesma ordem)],
  "fechamento": [string, string]
}
Escreve tudo no idioma pedido.`;

function buildPrompt(businessProfile, lead, idioma) {
  return `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

OBJEÇÕES CLÁSSICAS A RESPONDER (pela mesma ordem):
${OBJECOES_BASE.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Responde só com o objeto JSON.`;
}

// POST { lead, businessProfile, idioma?, baseId?, tableId?, recordId? }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['ANTHROPIC_API_KEY']);
    const { lead, businessProfile, idioma = 'Português de Portugal (PT-PT)', baseId, tableId, recordId } = req.body || {};
    if (!lead || !businessProfile) return res.status(400).json({ error: 'lead e businessProfile são obrigatórios' });

    const text = await callClaude({ system: SYSTEM, prompt: buildPrompt(businessProfile, lead, idioma), maxTokens: 2000 });
    const result = parseJsonLoose(text);

    if (baseId && tableId && recordId) {
      await airtableEnsureFields(baseId, tableId, OBJ_FIELDS);
      const readable = result.objecoes.map((o) => `Objeção: ${o.objecao}\nResposta: ${o.resposta}`).join('\n\n')
        + `\n\nFecho 1: ${result.fechamento[0]}\nFecho 2: ${result.fechamento[1]}`;
      await airtableUpdateRecord(baseId, tableId, recordId, { 'Roteiro Anti-Objeção': readable });
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
