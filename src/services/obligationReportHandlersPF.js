// ============================================================
// AURA - obligationReportHandlersPF (PR41 Sprint C, 2026-04-28)
//
// Handlers especificos pra dentista PESSOA FISICA (autonomo, sem CNPJ).
// Carregados dinamicamente pelo obligationReportGenerator.js
//
// Codes cobertos:
// - CARNE_LEAO        -> carne_leao
// - GPS_INSS_PF       -> gps_inss_pf
// - ISS_RPS_PF        -> iss_rps_pf
// - LIVRO_CAIXA_PF    -> livro_caixa_pf
// - IRPF_PF_ANUAL     -> irpf_pf_anual
// ============================================================

const db = require('../config/database');

// ----- Helpers -----
function fmtBR(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function previousMonth(referenceDate = new Date()) {
  const d = new Date(referenceDate);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = d.getMonth();
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59) };
}

async function getCompanyContext(companyId) {
  const { rows } = await db.query(
    `SELECT id, trade_name, legal_name, cnpj, cnae_code, tax_regime,
            address, phone, email
     FROM companies WHERE id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

async function sumIncomeBetween(companyId, start, end) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE company_id = $1 AND type = 'income' AND created_at >= $2 AND created_at <= $3`,
    [companyId, start, end]
  );
  return parseFloat(rows[0].total);
}

async function sumDespesasDedutiveis(companyId, start, end) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE company_id = $1 AND type = 'expense'
       AND created_at >= $2 AND created_at <= $3
       AND (
         category IN ('rent', 'utilities', 'materials', 'salary', 'office', 'aluguel', 'agua_luz', 'materiais')
         OR description ILIKE '%aluguel%'
         OR description ILIKE '%agua%' OR description ILIKE '%luz%'
         OR description ILIKE '%material%' OR description ILIKE '%insumo%'
         OR description ILIKE '%salario%' OR description ILIKE '%auxiliar%'
       )`,
    [companyId, start, end]
  );
  return parseFloat(rows[0].total);
}

// Tabela IRPF / Carne-Leao 2026 (mensal)
const IRPF_TABELA_2026 = [
  { ate: 2259.20, aliq: 0, deduzir: 0 },
  { ate: 2826.65, aliq: 0.075, deduzir: 169.44 },
  { ate: 3751.05, aliq: 0.15, deduzir: 381.44 },
  { ate: 4664.68, aliq: 0.225, deduzir: 662.77 },
  { ate: Infinity, aliq: 0.275, deduzir: 896.00 },
];

function calcCarneLeao(baseTributavel) {
  const faixa = IRPF_TABELA_2026.find(f => baseTributavel <= f.ate);
  if (!faixa || faixa.aliq === 0) return { imposto: 0, faixa };
  const imposto = baseTributavel * faixa.aliq - faixa.deduzir;
  return { imposto: Math.max(0, imposto), faixa };
}

// ============================================================
// HANDLERS
// ============================================================

async function carne_leao(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();
  const receita = await sumIncomeBetween(companyId, start, end);
  const despesas = await sumDespesasDedutiveis(companyId, start, end);

  const baseAposDespesas = Math.max(0, receita - despesas);
  const inssEstimado = receita * 0.11;
  const baseFinal = Math.max(0, baseAposDespesas - inssEstimado);

  const { imposto, faixa } = calcCarneLeao(baseFinal);

  const content = JSON.stringify({
    cnpj_ou_cpf: c?.cnpj || '(cadastrar CPF)',
    nome: c?.legal_name || c?.trade_name,
    competencia: `${start.getMonth() + 1}/${start.getFullYear()}`,
    receita_bruta: receita,
    despesas_dedutiveis: despesas,
    base_apos_despesas: baseAposDespesas,
    inss_estimado_11pct: inssEstimado,
    base_tributavel_final: baseFinal,
    aliquota_aplicada: ((faixa?.aliq || 0) * 100).toFixed(1) + '%',
    imposto_devido: imposto,
    codigo_darf: '0190 (Carne-Leao)',
    aviso: 'Confirme despesas no Livro Caixa. INSS estimado em 11% - usar valor real pago.',
  }, null, 2);

  return {
    format: 'json',
    filename: `CARNE_LEAO_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `Carne-Leao ${start.getMonth() + 1}/${start.getFullYear()}: receita ${fmtBRL(receita)} | imposto ${fmtBRL(imposto)}`,
    instructions: [
      '1. Acessar https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/carne-leao',
      '2. Login com CPF + senha gov.br',
      '3. Lancar receitas (do JSON acima) por pagador',
      '4. Lancar despesas dedutiveis do Livro Caixa',
      '5. Sistema calcula imposto e gera DARF',
      '6. Pagar DARF codigo 0190 ate ultimo dia util do mes',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/carne-leao',
  };
}

async function gps_inss_pf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start } = previousMonth();
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
  const receitaMes = await sumIncomeBetween(companyId, start, end);

  const tetoInss = 7786.02;
  const aliq11 = Math.min(receitaMes, tetoInss) * 0.11;
  const aliq20 = Math.min(receitaMes, tetoInss) * 0.20;

  return {
    format: 'guide_text',
    filename: `GPS_INSS_PF_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`GPS - INSS Contribuinte Individual
=====================================
Nome: ${c?.legal_name || c?.trade_name || ''}
CPF/CNPJ: ${c?.cnpj || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
Receita do mes: ${fmtBRL(receitaMes)}

DUAS OPCOES DE PLANO:

OPCAO 1 - PLANO SIMPLIFICADO (11%)
- Codigo de pagamento: 1163
- Aliquota: 11% sobre receita (ate teto)
- Valor: ${fmtBRL(aliq11)}
- Limita beneficio ao salario minimo (nao da pra aposentar pelo teto)

OPCAO 2 - PLANO NORMAL (20%)
- Codigo de pagamento: 1007
- Aliquota: 20% sobre receita (ate teto)
- Valor: ${fmtBRL(aliq20)}
- Permite aposentadoria pelo valor real (ate teto)

TETO INSS 2026: R$7.786,02
PISO: 1 salario minimo (R$1.518,00 em 2026)

COMO PAGAR:
1. Acessar https://www.gov.br/inss/pt-br/servicos/contribuinte-individual
   ou app/site Receita Previc
2. Login GOV.BR
3. Aba "Carne de pagamento - Contribuinte Individual"
4. Codigo de pagamento (1007 ou 1163)
5. Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
6. Imprimir GPS e pagar via internet banking ate dia 15

ATENCAO: Inadimplencia INSS suspende auxilios e atrasa carencia.

DICA: Configure debito automatico mensal pra nao esquecer.`,
    summary: `GPS INSS PF: ${fmtBRL(aliq11)} (plano simpl) ou ${fmtBRL(aliq20)} (plano normal). Vencimento dia 15.`,
    instructions: [
      '1. Decidir entre plano 11% (simplificado) ou 20% (normal)',
      '2. Acessar portal Receita Previc com login GOV.BR',
      '3. Emitir GPS com codigo 1007 (20%) ou 1163 (11%)',
      '4. Pagar ate dia 15',
    ],
    help_url: 'https://www.gov.br/inss/pt-br/servicos/contribuinte-individual',
  };
}

async function iss_rps_pf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start } = previousMonth();
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
  const receitaMes = await sumIncomeBetween(companyId, start, end);
  const aliqEstimada = 0.05;
  const issEstimado = receitaMes * aliqEstimada;

  return {
    format: 'guide_text',
    filename: `ISS_RPS_PF_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`ISS / RPS Municipal - Dentista PF
====================================
Nome: ${c?.legal_name || c?.trade_name || ''}
CPF: ${c?.cnpj || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
Receita do mes: ${fmtBRL(receitaMes)}

ALIQUOTA ESTIMADA: 5% (varia por municipio)
ISS ESTIMADO: ${fmtBRL(issEstimado)}

ATENCAO: Dentista PF pode ter 2 regimes:

REGIME A - ISS FIXO (RPA - Regime Profissional Autonomo)
- Pagamento ANUAL fixo (ex Sao Paulo R$1.200/ano em 2026)
- Independe da receita do mes
- Vantagem: previsivel e geralmente menor que 5% mensal
- Verifique no portal da prefeitura

REGIME B - ISS VARIAVEL (sobre receita mensal)
- 2-5% sobre cada nota emitida
- Recolhe via NFS-e ou guia mensal
- Vantagem: paga so se faturou

COMO PAGAR:
1. Acessar portal NFS-e do municipio (ou da Prefeitura)
2. Login com CPF + senha (ou e-CPF)
3. Verificar se voce esta em RPA fixo ou ISS variavel
4. RPA: pagar carne anual (1x ao ano)
5. Variavel: emitir NFS-e por servico + ISS gerado automatico
6. Vencimento padrao: ate dia 10 do mes subsequente

DICA: Em SP, dentista pode optar por ISS fixo via Cadastro de Contribuintes
Mobiliarios (CCM) - geralmente mais barato.`,
    summary: `ISS PF estimado: ${fmtBRL(issEstimado)} (5% sobre ${fmtBRL(receitaMes)}). Verifique se RPA fixo eh melhor.`,
    instructions: [
      '1. Verificar regime atual no portal da prefeitura',
      '2. Comparar RPA anual vs ISS variavel mensal',
      '3. Se RPA: pagar carne 1x/ano',
      '4. Se variavel: emitir NFS-e e pagar ISS mensal',
    ],
    help_url: null,
  };
}

async function livro_caixa_pf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();

  const { rows: trans } = await db.query(
    `SELECT created_at, type, amount, description, category
     FROM transactions
     WHERE company_id = $1 AND created_at >= $2 AND created_at <= $3
     ORDER BY created_at`,
    [companyId, start, end]
  );

  const linhas = trans.map(t => {
    const dataBR = fmtBR(t.created_at);
    const tipo = t.type === 'income' ? 'RECEITA' : 'DESPESA';
    const desc = (t.description || '-').replace(/[;\n]/g, ' ');
    const cat = t.category || '-';
    return `${dataBR};${tipo};${cat};${desc};${parseFloat(t.amount).toFixed(2)}`;
  });

  const totalReceitas = trans.filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  const totalDespesas = trans.filter(t => t.type === 'expense').reduce((a, t) => a + parseFloat(t.amount), 0);
  const resultado = totalReceitas - totalDespesas;

  const csv =
`# Livro-Caixa Dentista PF - ${start.getMonth() + 1}/${start.getFullYear()}
# Nome: ${c?.legal_name || c?.trade_name || ''}
# CPF: ${c?.cnpj || ''}
# Resumo:
#   Total Receitas: ${fmtBRL(totalReceitas)}
#   Total Despesas: ${fmtBRL(totalDespesas)}
#   Resultado:      ${fmtBRL(resultado)}
#
Data;Tipo;Categoria;Descricao;Valor
${linhas.join('\n')}`;

  return {
    format: 'csv',
    filename: `LIVRO_CAIXA_PF_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.csv`,
    content: csv,
    summary: `Livro Caixa ${start.getMonth() + 1}/${start.getFullYear()}: ${trans.length} lancamentos | Resultado ${fmtBRL(resultado)}`,
    instructions: [
      '1. Abrir CSV em Excel pra revisar lancamentos',
      '2. Adicionar receitas/despesas que faltaram (pode ter pago em dinheiro)',
      '3. Anexar comprovantes (notas, recibos) por lancamento',
      '4. Importar valores no Carne-Leao Web mensalmente',
      '5. Manter por 5 anos pra fiscalizacao',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/carne-leao',
  };
}

async function irpf_pf_anual(companyId) {
  const c = await getCompanyContext(companyId);
  const ano = new Date().getFullYear();
  const anoBase = ano - 1;
  const start = new Date(anoBase, 0, 1);
  const end = new Date(anoBase, 11, 31, 23, 59, 59);

  const totalReceita = await sumIncomeBetween(companyId, start, end);
  const totalDespesas = await sumDespesasDedutiveis(companyId, start, end);
  const baseTributavel = Math.max(0, totalReceita - totalDespesas);

  const baseMensal = baseTributavel / 12;
  const { imposto: impostoMensalEstimado } = calcCarneLeao(baseMensal);
  const impostoAnualEstimado = impostoMensalEstimado * 12;

  const content =
`IRPF Anual ${ano} - Dentista PF (ano-base ${anoBase})
=========================================================
Nome: ${c?.legal_name || c?.trade_name || ''}
CPF: ${c?.cnpj || ''}

RESUMO ANUAL:
  Receita Bruta Anual: ${fmtBRL(totalReceita)}
  Despesas Dedutiveis: ${fmtBRL(totalDespesas)}
  Base Tributavel:     ${fmtBRL(baseTributavel)}
  Base Mensal Media:   ${fmtBRL(baseMensal)}
  Imposto Estimado:    ${fmtBRL(impostoAnualEstimado)}

LIVRO CAIXA RESUMIDO (anual):
- Pacientes pagantes: ${fmtBRL(totalReceita)}
- Despesas profissionais: ${fmtBRL(totalDespesas)}
  (aluguel consultorio, agua/luz, materiais, auxiliares)

RENDIMENTOS A INFORMAR NO IRPF:
1. Aba "Rendimentos Tributaveis Recebidos PF/Exterior":
   - Total recebido de PF: ${fmtBRL(totalReceita)}
   - DARF Carne-Leao pago no ano (consultar comprovantes)
   - INSS contribuinte individual pago no ano

2. Aba "Livro Caixa":
   - Receita: ${fmtBRL(totalReceita)}
   - Despesas dedutiveis: ${fmtBRL(totalDespesas)}
   - Resultado tributavel: ${fmtBRL(baseTributavel)}

DEDUCOES IMPORTANTES:
- Plano de saude pessoal (limite anual)
- Educacao filhos/voce (R$3.561,50/dependente em 2026)
- INSS contribuinte individual (integral)
- Previdencia privada (PGBL ate 12% rendimento bruto)
- Doacoes (ate 6% imposto devido)
- Pensao alimenticia (judicial)

ENTREGAR ATE: 31 de maio de ${ano}

COMO DECLARAR:
1. Baixar IRPF ${ano} no portal Receita
2. Importar declaracao do ano anterior (se existir)
3. Aba "Rendimentos Tributaveis Recebidos PF":
   - Lancar cada pagador (ou consolidado se trabalhou em clinica)
4. Aba "Livro Caixa":
   - Importar do CSV (Aura gera mensalmente)
5. Aba "Bens e Direitos":
   - Imoveis, veiculos, contas, investimentos
6. Aba "Pagamentos Efetuados":
   - INSS pago (codigo 51)
   - DARF Carne-Leao (codigo 31)
   - Previdencia, plano saude, educacao
7. Conferir + Transmitir
8. Pagar ou receber restituicao

ATENCAO: Sem entrega = irregular CPF + multa minima R$165,74
Atraso: 1% imposto/mes ate maximo 20%`;

  return {
    format: 'txt',
    filename: `IRPF_PF_ANUAL_${anoBase}.txt`,
    content,
    summary: `IRPF ${ano} (PF, ano-base ${anoBase}): receita ${fmtBRL(totalReceita)} | imposto estimado ${fmtBRL(impostoAnualEstimado)}`,
    instructions: [
      '1. Baixar programa IRPF ' + ano,
      '2. Importar Livro Caixa do Aura (CSV mensal)',
      '3. Lancar Carne-Leao DARFs pagos',
      '4. Lancar bens, deducoes, dependentes',
      '5. Transmitir ate 31/05/' + ano,
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda',
  };
}

module.exports = {
  carne_leao,
  gps_inss_pf,
  iss_rps_pf,
  livro_caixa_pf,
  irpf_pf_anual,
};
