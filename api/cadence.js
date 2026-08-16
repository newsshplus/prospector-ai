import { cors, requireEnv, callClaude, parseJsonLoose, airtableEnsureFields, airtableUpdateRecord } from './_lib.js';

const CADENCE_FIELDS = [
  { name: 'Cadência 21 Dias', type: 'multilineText' },
];

const SYSTEM = `És o estratega de cadências de outbound B2B omnichannel.
Recebes o perfil do negócio do utilizador e os dados de um lead que não respondeu ao primeiro contacto.
Gera o conteúdo completo de uma cadência de 21 dias com este mapa temporal fixo (não alteres os dias nem os canais):

- Dia 1: WhatsApp (quebra de padrão, curioso, não genérico) + Email #1 (estrutura AIDA, valor direto).
- Dia 3: Email #2 (prova social / caso de referência do mesmo nicho).
- Dia 5: Ligação telefónica (abertura curta de 3 frases — o roteiro completo de objeções é gerado noutro módulo, aqui só a abertura) + WhatsApp de lembrete ("tentei ligar...").
- Dia 8: Email #3 (conteúdo educativo / insight de mercado relevante para o nicho do lead).
- Dia 12: WhatsApp (pergunta direta de sim/não, muito curta).
- Dia 16: Email #4 (última tentativa de valor, sem pressão).
- Dia 21: Email de despedida ("breakup email" — tom leve, sem culpa, deixa a porta aberta).

Regras obrigatórias:
- O tom varia genuinamente entre toques — nunca repete a mesma estrutura de frase.
- No Dia 3 (prova social): NUNCA inventes um nome de cliente, empresa ou testemunho específico. Se o perfil do negócio do utilizador não fornecer um caso real, usa uma referência genérica e honesta (ex: "empresas do mesmo setor que trabalhámos" sem citar nomes ou números inventados) — nunca apresentes um caso fabricado como se fosse real.
- No Dia 8 (conteúdo educativo): o insight tem de ser genuinamente útil e específico ao nicho do lead, não genérico.
- Todas as mensagens devem soar humanas, nunca a IA ou a template automático.
- Escreve tudo no idioma pedido, português europeu por defeito, sem brasileirismos.

Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "cadencia": [
    {"dia": 1, "canais": ["whatsapp","email"], "whatsapp": string, "emailAssunto": string, "emailCorpo": string},
    {"dia": 3, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 5, "canais": ["ligacao","whatsapp"], "roteiroLigacao": string, "whatsapp": string},
    {"dia": 8, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 12, "canais": ["whatsapp"], "whatsapp": string},
    {"dia": 16, "canais": ["email"], "emailAssunto": string, "emailCorpo": string},
    {"dia": 21, "canais": ["email"], "emailAssunto": string, "emailCorpo": string}
  ]
}`;

function buildPrompt(businessProfile, lead, idioma) {
  return `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

Responde só com o objeto JSON.`;
}

function crmStopTaskPayload(lead) {
  return {
    descricao: 'Payload de exemplo para a tarefa de CRM a criar quando o lead responder em qualquer canal — a regra de paragem em si tem de ser implementada no teu workflow n8n (ouvir respostas inbound de WhatsApp/Email e cancelar os envios agendados desta cadência).',
    body: {
      title: 'LEAD RESPONDEU — ASSUMIR ATENDIMENTO HUMANO',
      lead: lead.Empresa || lead.empresa || '',
      acao: 'Parar imediatamente todos os toques agendados desta cadência e passar para atendimento humano.',
    },
  };
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

    const text = await callClaude({ system: SYSTEM, prompt: buildPrompt(businessProfile, lead, idioma), maxTokens: 4000 });
    const result = parseJsonLoose(text);

    if (baseId && tableId && recordId) {
      await airtableEnsureFields(baseId, tableId, CADENCE_FIELDS);
      const readable = result.cadencia
        .map((t) => {
          const lines = [`Dia ${t.dia} (${t.canais.join(' + ')})`];
          if (t.whatsapp) lines.push(`WhatsApp: ${t.whatsapp}`);
          if (t.roteiroLigacao) lines.push(`Ligação: ${t.roteiroLigacao}`);
          if (t.emailAssunto) lines.push(`Email — ${t.emailAssunto}\n${t.emailCorpo}`);
          return lines.join('\n');
        })
        .join('\n\n---\n\n');
      await airtableUpdateRecord(baseId, tableId, recordId, { 'Cadência 21 Dias': readable });
    }

    res.status(200).json({
      cadencia: result.cadencia,
      regraParagem: {
        descricao: 'Se o lead responder em QUALQUER canal, interromper imediatamente os toques seguintes e criar tarefa no CRM.',
        crmPayload: crmStopTaskPayload(lead),
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
