import { cors, requireEnv, requireAuth, airtableList, airtableEnsureFields, computeReportStats, callAI } from './_lib.js';

const REPORT_FIELDS = [
  {
    name: 'Resultado Final',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'Em aberto', color: 'grayBright' },
        { name: 'Fechado - Ganho', color: 'greenBright' },
        { name: 'Fechado - Perdido', color: 'redBright' },
      ],
    },
  },
  { name: 'Valor do Negócio', type: 'number', options: { precision: 2 } },
];

const SYSTEM = `És o "Chief Revenue & Systems Analyst" de um sistema de prospecção B2B.
Recebes um bloco de DADOS REAIS já calculados a partir do pipeline de leads do utilizador (contagens, médias, taxas de conversão por classificação e por tecnologia).

REGRA ABSOLUTA: nunca inventes, estimes ou "arredondes de forma otimista" nenhum número que não esteja no bloco de dados. Se um KPI pedido não constar dos dados (ex: taxa de entrega de email, taxa de abertura, CPL sem custo informado), escreve explicitamente "Dados insuficientes — [explica o que falta para calcular]" em vez de aproximar ou supor um valor plausível.

Com base SÓ nos dados reais fornecidos, escreve:
1. Um resumo executivo curto (3-5 frases) do estado do pipeline.
2. Os principais insights da matriz de conversão por classificação e por tech stack (só comenta o que os dados realmente mostram; se a amostra for pequena, diz isso).
3. Uma sugestão concreta de reescrita das diretrizes de scoring do ICP Match Engine, ajustando o peso dado a cada critério com base nos padrões reais de conversão observados — mas deixa claro que é uma SUGESTÃO para revisão humana, não uma alteração já aplicada.

Escreve tudo em português europeu (PT-PT), sem brasileirismos. Responde em texto corrido bem estruturado com títulos curtos, não em JSON.`;

// GET ?baseId=&tableId=&custoMensal=
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  try {
    requireAuth(req);
    requireEnv(['AIRTABLE_TOKEN', 'ANTHROPIC_API_KEY']);
    const { baseId, tableId, custoMensal } = req.query;
    if (!baseId || !tableId) return res.status(400).json({ error: 'baseId e tableId são obrigatórios' });

    await airtableEnsureFields(baseId, tableId, REPORT_FIELDS);

    const records = await airtableList(baseId, tableId);
    const leads = records.map((r) => r.fields);
    const custo = custoMensal ? parseFloat(custoMensal) : null;
    const stats = computeReportStats(leads, custo);

    let narrative = '';
    if (leads.length > 0) {
      narrative = await callAI({
        system: SYSTEM,
        prompt: `DADOS REAIS DO PIPELINE:\n${JSON.stringify(stats, null, 2)}\n\nEscreve o relatório.`,
        maxTokens: 2500,
      });
    } else {
      narrative = 'Ainda não há leads nesta base — corre uma prospecção primeiro para gerares o relatório.';
    }

    res.status(200).json({ stats, narrative });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
