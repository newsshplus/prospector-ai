import { cors, requireEnv, callClaude, parseJsonLoose, detectTechStack, airtableEnsureFields, airtableUpdateRecord } from './_lib.js';

const ENRICHMENT_FIELDS = [
  { name: 'Cargo', type: 'singleLineText' },
  { name: 'Techs Utilizadas', type: 'multilineText' },
  { name: 'Fator de Urgência', type: 'multilineText' },
  { name: 'Budget Estimado', type: 'singleLineText' },
  { name: 'Intent Score', type: 'number', options: { precision: 0 } },
  {
    name: 'Prioridade de Disparo',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'Alta - Disparo imediato', color: 'redBright' },
        { name: 'Média - Fila padrão', color: 'yellowBright' },
        { name: 'Desqualificado', color: 'grayBright' },
      ],
    },
  },
];

const SYSTEM = `És o "Deep BANT & Tech-Stack Enricher", um agente de inteligência de prospecção B2B.
Recebes o perfil do negócio do utilizador, os dados brutos de um lead (empresa encontrada numa raspagem) e a tech stack já detetada tecnicamente no site dele.
Usa a ferramenta de pesquisa web para investigar: quem é o decisor-chave (CEO/CMO/CTO/Diretor de Operações — nome e cargo, via LinkedIn ou site institucional), sinais de urgência (vagas abertas no LinkedIn, expansão recente, notícias, tecnologia visivelmente desatualizada) e contexto de dimensão da empresa (nº de colaboradores, presença online) para estimar orçamento.

Depois de pesquisares, responde APENAS com um objeto JSON válido (sem markdown, sem texto antes/depois) com esta forma exata:
{
  "cargo": string (cargo do decisor-chave encontrado, ou "Não identificado"),
  "decisorChave": string (nome do decisor-chave, ou "Não identificado"),
  "budget": string (estimativa de orçamento em faixa, ex: "500-1500€/mês", sempre rotulado como estimativa, nunca como facto confirmado),
  "authority": string (1 frase sobre a estrutura de decisão encontrada),
  "need": [string, string, string] (exatamente 3 falhas operacionais/estéticas/tecnológicas reais e específicas encontradas),
  "timeline": string (1 frase resumindo o indicador de urgência mais forte encontrado, ou "Sem sinais de urgência identificados"),
  "techStack": [string] (lista de tecnologias detetadas, combina as já fornecidas com o que encontrares),
  "intentScore": number (0-100, segue a matriz: >80 alta prioridade, 50-79 média, <50 desqualificado),
  "prioridade": "Alta - Disparo imediato" | "Média - Fila padrão" | "Desqualificado"
}
Sê honesto sobre incerteza: se não encontrares um decisor ou sinal de urgência, di-lo explicitamente em vez de inventar. Escreve tudo em português europeu (PT-PT), sem brasileirismos.`;

function buildPrompt(businessProfile, lead, techDetected) {
  return `PERFIL DO MEU NEGÓCIO:
${JSON.stringify(businessProfile, null, 2)}

LEAD (dados brutos da raspagem):
${JSON.stringify(lead, null, 2)}

TECH STACK JÁ DETETADA TECNICAMENTE NO SITE (via análise do HTML, confiança alta):
${techDetected.length ? techDetected.join(', ') : 'Nenhuma detetada automaticamente — investiga via pesquisa web.'}

Investiga o decisor-chave, sinais de urgência (BANT+) e confirma/complementa a tech stack. Responde só com o objeto JSON.`;
}

// POST { lead, businessProfile, baseId?, tableId?, recordId? }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    requireEnv(['ANTHROPIC_API_KEY']);
    const { lead, businessProfile, baseId, tableId, recordId } = req.body || {};
    if (!lead || !businessProfile) return res.status(400).json({ error: 'lead e businessProfile são obrigatórios' });

    const website = lead.Website || lead.website;
    const { detected: techDetected } = await detectTechStack(website);

    const text = await callClaude({
      system: SYSTEM,
      prompt: buildPrompt(businessProfile, lead, techDetected),
      maxTokens: 3000,
      webSearch: true,
    });
    const enrichment = parseJsonLoose(text);

    // combina tech stack detetada tecnicamente (confiança alta) com a que a IA encontrou
    const techStack = Array.from(new Set([...(techDetected || []), ...(enrichment.techStack || [])]));
    enrichment.techStack = techStack;

    if (baseId && tableId && recordId) {
      await airtableEnsureFields(baseId, tableId, ENRICHMENT_FIELDS);
      await airtableUpdateRecord(baseId, tableId, recordId, {
        Cargo: enrichment.cargo,
        Decisor: enrichment.decisorChave,
        'Techs Utilizadas': techStack.join(', '),
        'Fator de Urgência': enrichment.timeline,
        'Budget Estimado': enrichment.budget,
        'Intent Score': enrichment.intentScore,
        'Prioridade de Disparo': enrichment.prioridade,
        'Dor Identificada': Array.isArray(enrichment.need) ? enrichment.need.join(' · ') : enrichment.need,
      });
    }

    res.status(200).json({ enrichment });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
