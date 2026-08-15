import { cors, requireEnv, callClaude, parseJsonLoose, checkEmailDeliverability, airtableEnsureFields, airtableUpdateRecord } from './_lib.js';

const DELIV_FIELDS = [
  { name: 'WhatsApp Var 3', type: 'multilineText' },
  { name: 'Verificação Email', type: 'multilineText' },
];

// Lista best-effort de palavras/frases que costumam ativar filtros de spam de WhatsApp/Email.
// Não é exaustiva nem científica — serve como rede de segurança, não como garantia.
const SPAM_TRIGGERS = [
  'grátis', 'gratis', 'ganhe dinheiro', 'promoção', 'promocao', 'oportunidade única', 'oportunidade unica',
  'clique aqui', 'link abaixo', 'desconto', 'compre já', 'compre ja', 'garantido a 100%', '100% garantido',
  'última chance', 'ultima chance', 'não perca', 'nao perca', 'urgente', 'oferta imperdível', 'oferta imperdivel',
];

function scanTriggers(text) {
  const lower = (text || '').toLowerCase();
  return SPAM_TRIGGERS.filter((t) => lower.includes(t));
}

const SYSTEM = `És um especialista em qualidade e entregabilidade de outbound B2B (WhatsApp e Email).
A tua função é escrever variações de alta qualidade que soam genuinamente humanas e evitam linguagem que ativa filtros de spam — não para contornar sistemas de proteção das plataformas, mas porque linguagem exageradamente promocional reduz taxas de resposta e é normalmente sinalizada como spam por qualquer filtro (WhatsApp, Gmail, Outlook).

Regras obrigatórias:
1. Gera 3 variações da mensagem de WhatsApp para o lead. As variações devem ter aberturas, ângulos e fechos genuinamente diferentes entre si — não parafraseia trivialmente a mesma frase.
2. Usa parágrafos curtos com quebras de linha naturais (como alguém escreveria mesmo no telemóvel), tom profissional e conversacional, no idioma pedido.
3. NUNCA uses estas palavras/frases: grátis, ganhe dinheiro, promoção, oportunidade única, clique aqui, link abaixo, desconto, compre já, garantido a 100%, última chance, não perca, urgente, oferta imperdível.
4. Gera também a versão de email em texto simples (plain text): sem HTML, sem imagens, sem botões, parágrafos curtos, assinatura profissional simples de 2-3 linhas — otimizada para caixa de entrada principal em vez de promoções/spam.
Responde APENAS com JSON válido, sem markdown, com esta forma exata:
{
  "whatsappVariacoes": [string, string, string],
  "emailPlainText": string
}`;

function buildPrompt(businessProfile, lead, idioma) {
  return `IDIOMA: ${idioma}

PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD:
${JSON.stringify(lead, null, 2)}

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

    const email = lead.Email || lead.email;
    const [text, emailCheck] = await Promise.all([
      callClaude({ system: SYSTEM, prompt: buildPrompt(businessProfile, lead, idioma), maxTokens: 2500 }),
      checkEmailDeliverability(email),
    ]);
    const generated = parseJsonLoose(text);

    // Rede de segurança: verifica se alguma palavra-gatilho passou apesar da instrução.
    const avisos = [];
    generated.whatsappVariacoes.forEach((v, i) => {
      const hits = scanTriggers(v);
      if (hits.length) avisos.push(`Variação WhatsApp ${i + 1} contém termo(s) a rever: ${hits.join(', ')}`);
    });
    const emailHits = scanTriggers(generated.emailPlainText);
    if (emailHits.length) avisos.push(`Email contém termo(s) a rever: ${emailHits.join(', ')}`);

    if (baseId && tableId && recordId) {
      await airtableEnsureFields(baseId, tableId, DELIV_FIELDS);
      const emailSummary = email
        ? `MX: ${emailCheck.mx ? 'OK' : 'em falta'} · SPF: ${emailCheck.spf ? 'OK' : 'em falta'} · DMARC: ${emailCheck.dmarc ? 'OK' : 'em falta'} · DKIM: ${emailCheck.dkimSelectorFound ? 'seletor "' + emailCheck.dkimSelectorFound + '" encontrado' : 'não confirmado (best-effort)'}`
        : 'Sem email no lead para verificar.';
      await airtableUpdateRecord(baseId, tableId, recordId, {
        'WhatsApp Msg 1': generated.whatsappVariacoes[0],
        'WhatsApp Msg 2': generated.whatsappVariacoes[1],
        'WhatsApp Var 3': generated.whatsappVariacoes[2],
        'Email Corpo': generated.emailPlainText,
        'Verificação Email': emailSummary,
      });
    }

    res.status(200).json({
      whatsappVariacoes: generated.whatsappVariacoes,
      emailPlainText: generated.emailPlainText,
      emailCheck,
      avisos,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
