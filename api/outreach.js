import { cors, requireEnv, airtableUpdateRecord, callClaude, parseJsonLoose } from './_lib.js';

const SYSTEM = `És um copywriter sénior B2B especializado em outbound humano (não soa a IA).
Recebes o perfil do negócio do remetente e os dados de um lead qualificado.
Gera abordagens ultrapersonalizadas com tom 100% humano — nunca uses frases genéricas como
"espero que este email o encontre bem". Baseia-te sempre na dor identificada do lead.
Escreve tudo no idioma pedido (variante indicada). Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "whatsapp1": string (abertura de curiosidade, baseada numa falha/oportunidade real da empresa, tom direto),
  "whatsapp2": string (foco em ROI direto, mais curto, estilo texto/áudio transcrito),
  "emailAssunto": string (hiper-específico, sem soar a spam),
  "emailCorpo": string (estrutura AIDA/PAS, cita o nome do decisor se existir e a dor identificada),
  "scriptLigacao": string (com 3 partes claras: quebra de gelo de 5s, pergunta de ancoragem sobre a dor, pitch de 15s para agendar reunião — separa as partes com quebras de linha)
}`;

function buildPrompt(businessProfile, lead, idioma) {
  return `IDIOMA DA ABORDAGEM: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

Responde só com o objeto JSON.`;
}

function waPayload(lead, message) {
  return {
    descricao: 'Payload para Z-API / Evolution API — adaptar ao endpoint do teu WhatsApp Business',
    endpointExemplo: 'POST {SEU_HOST_ZAPI_OU_EVOLUTION}/send-text',
    body: { phone: lead.Telefone || lead.telefone || '', message },
  };
}

function emailPayload(lead, subject, body) {
  return {
    descricao: 'Payload para Resend / SendGrid',
    endpointExemplo: 'POST https://api.resend.com/emails',
    body: {
      to: lead.Email || lead.email || '',
      subject,
      text: body,
    },
  };
}

function crmPayload(lead, nextAction) {
  return {
    descricao: 'Payload para tarefa no CRM (HubSpot / Pipedrive)',
    body: {
      title: `Ligar para ${lead.Empresa || lead.empresa || ''}`,
      note: nextAction || 'Ligação de qualificação',
      dueInDays: 2,
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

    const text = await callClaude({ system: SYSTEM, prompt: buildPrompt(businessProfile, lead, idioma), maxTokens: 2000 });
    const msgs = parseJsonLoose(text);

    if (baseId && tableId && recordId) {
      await airtableUpdateRecord(baseId, tableId, recordId, {
        'WhatsApp Msg 1': msgs.whatsapp1,
        'WhatsApp Msg 2': msgs.whatsapp2,
        'Email Assunto': msgs.emailAssunto,
        'Email Corpo': msgs.emailCorpo,
        'Script Ligação': msgs.scriptLigacao,
      });
    }

    res.status(200).json({
      messages: msgs,
      webhookPayloads: {
        whatsapp: waPayload(lead, msgs.whatsapp1),
        email: emailPayload(lead, msgs.emailAssunto, msgs.emailCorpo),
        crm: crmPayload(lead, msgs.proximaAcao),
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
