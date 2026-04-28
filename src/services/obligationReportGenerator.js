// ============================================================
// AURA. — obligationReportGenerator (PR39, 2026-04-28)
//
// Diretriz: Aura automatiza a entrega da obrigacao OU gera relatorio
// formatado pronto com tudo que o user precisa pra entregar no
// portal externo (Receita, Anvisa, CRO, Vigilancia, etc).
//
// Cada handler recebe (companyId, params) e devolve:
//   { format, filename, content, summary, instructions, help_url, generated_at }
//
// format: 'pdf' | 'csv' | 'json' | 'xml' | 'txt' | 'guide_text'
// content: string (txt/csv/json/xml) ou Buffer (pdf - placeholder por enquanto)
// summary: resumo curto do que foi gerado (mostrado na UI)
// instructions: passos numerados pro user enviar/pagar
// help_url: portal externo
//
// PR38: 9 handlers reais (PoC) + fallback generico.
// PR39: +17 handlers novos cobrindo Lucro Presumido/Real, MEI, eSocial,
//       Fator R, DEFIS, IRPF socios, PGR, Livro Receituario etc.
// ============================================================

const db = require('../config/database');

// ============================================================
// Helpers comuns
// ============================================================
function fmtBR(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function startEndOfMonth(referenceDate = new Date()) {
  const y = referenceDate.getFullYear();
  const m = referenceDate.getMonth();
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0, 23, 59, 59) };
}
function previousMonth(referenceDate = new Date()) {
  const d = new Date(referenceDate);
  d.setMonth(d.getMonth() - 1);
  return startEndOfMonth(d);
}
function startEndOfQuarter(referenceDate = new Date()) {
  const y = referenceDate.getFullYear();
  const m = referenceDate.getMonth();
  const qStartMonth = Math.floor(m / 3) * 3;
  return {
    start: new Date(y, qStartMonth, 1),
    end: new Date(y, qStartMonth + 3, 0, 23, 59, 59),
  };
}
function startEndOfYear(referenceDate = new Date()) {
  const y = referenceDate.getFullYear();
  return { start: new Date(y, 0, 1), end: new Date(y, 11, 31, 23, 59, 59) };
}

async function getCompanyContext(companyId) {
  const { rows } = await db.query(
    `SELECT id, trade_name, legal_name, cnpj, cnae_code, tax_regime,
            address, phone, email,
            cro_state, cro_pj_number, cro_rt_number, cro_rt_user_id,
            cnes_number, vigilancia_alvara_expires_at, vigilancia_alvara_number
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

async function sumPayrollBetween(companyId, start, end) {
  // Folha = soma dos salarios dos employees ativos durante o periodo (proxy simples)
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(salary), 0) AS total
     FROM employees
     WHERE company_id = $1 AND is_active = true
       AND created_at <= $2
       AND (terminated_at IS NULL OR terminated_at >= $3)`,
    [companyId, end, start]
  );
  return parseFloat(rows[0].total);
}

async function getReceita12Meses(companyId, referenceDate = new Date()) {
  const end = new Date(referenceDate);
  const start = new Date(referenceDate);
  start.setMonth(start.getMonth() - 12);
  return sumIncomeBetween(companyId, start, end);
}

// ============================================================
// HANDLERS - Simples Nacional
// ============================================================

async function das_sn_darf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();
  const receita = await sumIncomeBetween(companyId, start, end);
  const aliquotaEstimada = 0.06; // 6% Anexo III faixa 1 - estimativa
  const valor = receita * aliquotaEstimada;

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    competencia: `${start.getMonth() + 1}/${start.getFullYear()}`,
    receita_bruta_mes: receita,
    aliquota_estimada: aliquotaEstimada,
    valor_estimado: valor,
    aviso: 'Estimativa pelo Anexo III faixa 1. PGDAS oficial calcula com receita 12 meses + ICMS/ISS exato.',
  }, null, 2);

  return {
    format: 'json',
    filename: `DAS_SN_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `Receita ${fmtBR(start)} a ${fmtBR(end)}: ${fmtBRL(receita)}. DAS estimado: ${fmtBRL(valor)}.`,
    instructions: [
      '1. Conferir receita do mes acima',
      '2. Acessar portal PGDAS-D (link abaixo) e logar com certificado digital',
      '3. Lancar valores - sistema oficial calcula aliquota efetiva exata',
      '4. Emitir DAS e pagar ate o dia 20',
    ],
    help_url: 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgdasd2018/',
  };
}

async function pgdas_d(companyId) {
  // PGDAS-D real precisa receita 12 meses pra calcular aliquota efetiva
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();
  const receitaMes = await sumIncomeBetween(companyId, start, end);
  const receita12m = await getReceita12Meses(companyId, end);

  // Tabela Anexo III (servico) 2026 - simplificada
  const faixas = [
    { ate: 180000, aliq: 0.06, deduzir: 0 },
    { ate: 360000, aliq: 0.112, deduzir: 9360 },
    { ate: 720000, aliq: 0.135, deduzir: 17640 },
    { ate: 1800000, aliq: 0.16, deduzir: 35640 },
    { ate: 3600000, aliq: 0.21, deduzir: 125640 },
    { ate: 4800000, aliq: 0.33, deduzir: 648000 },
  ];
  const faixa = faixas.find(f => receita12m <= f.ate) || faixas[faixas.length - 1];
  const aliqEfetiva = receita12m > 0 ? ((receita12m * faixa.aliq) - faixa.deduzir) / receita12m : faixa.aliq;
  const valorDas = receitaMes * aliqEfetiva;

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    competencia: `${start.getMonth() + 1}/${start.getFullYear()}`,
    receita_bruta_mes: receitaMes,
    receita_bruta_12m: receita12m,
    anexo: 'III (servico odonto)',
    faixa_nominal: faixa.aliq,
    parcela_deduzir: faixa.deduzir,
    aliquota_efetiva: Math.round(aliqEfetiva * 10000) / 100 + '%',
    valor_das_estimado: valorDas,
    aviso: 'Valor pode variar com Fator R. Se folha 12m / receita 12m >= 28%, mantem Anexo III. Senao, Anexo V.',
  }, null, 2);

  return {
    format: 'json',
    filename: `PGDAS_D_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `Receita 12m: ${fmtBRL(receita12m)} | Aliq efetiva: ${(aliqEfetiva * 100).toFixed(2)}% | DAS estimado: ${fmtBRL(valorDas)}`,
    instructions: [
      '1. Conferir receita 12 meses (sistema considera todas transactions income)',
      '2. Validar Fator R (ver obrigacao FATOR_R)',
      '3. Acessar PGDAS-D no portal - lancar valor mes',
      '4. Sistema oficial valida e gera DAS - pagar ate dia 20',
    ],
    help_url: 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgdasd2018/',
  };
}

async function das_mei(companyId) {
  const c = await getCompanyContext(companyId);
  const valorMensal = 75.90;
  const today = new Date();
  return {
    format: 'guide_text',
    filename: `DAS_MEI_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`DAS-MEI - Documento de Arrecadacao do Simples Nacional
======================================================
CNPJ: ${c?.cnpj || '(nao cadastrado)'}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Competencia: ${today.getMonth() + 1}/${today.getFullYear()}
Valor mensal MEI 2026: ${fmtBRL(valorMensal)}

Como pagar:
1. Acessar https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/PGMEI/
2. Logar com CNPJ + senha
3. Emitir DAS-MEI do mes
4. Pagar via boleto, PIX ou debito ate dia 20`,
    summary: `DAS MEI ${today.getMonth() + 1}/${today.getFullYear()} - ${fmtBRL(valorMensal)}`,
    instructions: ['1. Acessar portal MEI', '2. Emitir DAS-MEI do mes', '3. Pagar ate dia 20 via PIX/boleto'],
    help_url: 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/PGMEI/',
  };
}

async function defis(companyId) {
  // DEFIS - Declaracao anual: gera relatorio com 12 meses de receita
  const c = await getCompanyContext(companyId);
  const anoBase = new Date().getFullYear() - 1;
  const meses = [];
  let totalAno = 0;
  for (let m = 0; m < 12; m++) {
    const start = new Date(anoBase, m, 1);
    const end = new Date(anoBase, m + 1, 0, 23, 59, 59);
    const v = await sumIncomeBetween(companyId, start, end);
    totalAno += v;
    meses.push({ mes: `${m + 1}/${anoBase}`, receita_bruta: v });
  }

  const content =
`DEFIS - Declaracao de Informacoes Socioeconomicas e Fiscais
============================================================
Ano-base: ${anoBase}
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
CNAE: ${c?.cnae_code || ''} (servico odonto)

RECEITA BRUTA POR MES (R$)
${meses.map(m => `  ${m.mes.padEnd(8)} ${fmtBRL(m.receita_bruta)}`).join('\n')}
  --------
  TOTAL    ${fmtBRL(totalAno)}

INFORMACOES ADICIONAIS PRA PREENCHER NO PORTAL:
- Numero de funcionarios em 31/12/${anoBase}: (consultar tabela employees)
- Pagamento de pro-labore (sim/nao)
- Saldo em caixa em 31/12/${anoBase}
- Despesas com aluguel/agua/luz/internet
- Despesas com energia eletrica
- Compra de mercadorias/insumos
- Lucro distribuido aos socios

Prazo: 31 de marco do ano subsequente
Multa por atraso: R$ 50,00 a R$ 500,00`;

  return {
    format: 'txt',
    filename: `DEFIS_${anoBase}.txt`,
    content,
    summary: `DEFIS ${anoBase}: receita total ${fmtBRL(totalAno)} em 12 meses`,
    instructions: [
      '1. Conferir receita mensal acima',
      '2. Acessar portal Simples Nacional',
      '3. Login com certificado digital',
      '4. Aba DEFIS - lancar valores anuais + complementares',
      '5. Transmitir ate 31/03',
    ],
    help_url: 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/DEFIS2024/',
  };
}

async function fator_r(companyId) {
  // Fator R = folha 12m / receita 12m. Se >= 28% -> Anexo III, senao Anexo V
  const c = await getCompanyContext(companyId);
  const today = new Date();
  const receita12m = await getReceita12Meses(companyId);
  const start12m = new Date(today);
  start12m.setMonth(start12m.getMonth() - 12);
  const folha12m = await sumPayrollBetween(companyId, start12m, today) * 12; // salary mensal x 12

  const fatorR = receita12m > 0 ? folha12m / receita12m : 0;
  const anexoSugerido = fatorR >= 0.28 ? 'Anexo III (aliquotas menores)' : 'Anexo V (aliquotas maiores)';

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    competencia: `${today.getMonth() + 1}/${today.getFullYear()}`,
    receita_12m: receita12m,
    folha_12m: folha12m,
    fator_r: Math.round(fatorR * 10000) / 100 + '%',
    threshold: '28%',
    anexo_aplicavel: anexoSugerido,
    diferenca_pra_threshold: ((fatorR - 0.28) * 100).toFixed(2) + ' pp',
    recomendacao: fatorR < 0.28
      ? 'Considere aumentar pro-labore/contratacoes pra atingir 28% e migrar pra Anexo III. Diferenca de aliquota chega a 9pp.'
      : 'Fator R OK. Mantenha Anexo III.',
  }, null, 2);

  return {
    format: 'json',
    filename: `FATOR_R_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `Fator R: ${(fatorR * 100).toFixed(2)}% (threshold 28%). ${anexoSugerido}`,
    instructions: [
      '1. Validar receita 12m e folha 12m no JSON',
      fatorR < 0.28
        ? '2. Considere aumentar pro-labore - economia tributaria pode chegar a 9pp'
        : '2. Manter Anexo III - confirme com contador no PGDAS-D mensal',
      '3. Re-checar todo mes - Fator R recalcula constantemente',
    ],
    help_url: null,
  };
}

async function dasn_simei(companyId) {
  // DASN-SIMEI = declaracao anual MEI
  const c = await getCompanyContext(companyId);
  const anoBase = new Date().getFullYear() - 1;
  const start = new Date(anoBase, 0, 1);
  const end = new Date(anoBase, 11, 31, 23, 59, 59);
  const receitaAno = await sumIncomeBetween(companyId, start, end);

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    ano_base: anoBase,
    receita_bruta_anual: receitaAno,
    teto_mei: 81000,
    excedeu_teto: receitaAno > 81000,
    diferenca_pra_teto: 81000 - receitaAno,
    aviso: receitaAno > 81000
      ? 'ATENCAO: receita acima do teto MEI. Desenquadramento obrigatorio - migrar pra Simples Nacional ME.'
      : 'Dentro do teto MEI.',
  }, null, 2);

  return {
    format: 'json',
    filename: `DASN_SIMEI_${anoBase}.json`,
    content,
    summary: `DASN-SIMEI ${anoBase}: receita ${fmtBRL(receitaAno)} (teto ${fmtBRL(81000)})`,
    instructions: [
      '1. Acessar https://www8.receita.fazenda.gov.br/SimplesNacional/',
      '2. Login com CNPJ MEI + senha',
      '3. Aba DASN-SIMEI',
      '4. Informar receita bruta anual',
      '5. Informar se teve funcionario',
      '6. Transmitir ate 31/05',
    ],
    help_url: 'https://www8.receita.fazenda.gov.br/SimplesNacional/',
  };
}

async function mei_limit(companyId) {
  // Controle de limite MEI: receita rolling 12m vs R$ 81k
  const c = await getCompanyContext(companyId);
  const receita12m = await getReceita12Meses(companyId);
  const consumo = receita12m / 81000;
  const today = new Date();

  let alerta = 'OK';
  if (consumo >= 1) alerta = 'TETO ULTRAPASSADO - desenquadramento obrigatorio';
  else if (consumo >= 0.8) alerta = 'ALERTA - 80% do teto consumido';
  else if (consumo >= 0.5) alerta = 'ATENCAO - 50% do teto consumido';

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    competencia: `${today.getMonth() + 1}/${today.getFullYear()}`,
    receita_12m: receita12m,
    teto_mei: 81000,
    consumo_pct: Math.round(consumo * 10000) / 100 + '%',
    saldo_disponivel: 81000 - receita12m,
    alerta,
    recomendacao: consumo >= 0.8
      ? 'Planeje migracao pra Simples Nacional ME. Aliquota saltarah pra 6-15.5%.'
      : 'Continue acompanhando - re-rode esse relatorio mensal.',
  }, null, 2);

  return {
    format: 'json',
    filename: `MEI_LIMIT_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `Receita 12m: ${fmtBRL(receita12m)} (${(consumo * 100).toFixed(1)}% do teto). ${alerta}`,
    instructions: [
      '1. Conferir receita rolling 12 meses',
      consumo >= 0.5 ? '2. ATENCAO - planeje migracao pra Simples ME' : '2. Continuar monitorando mensalmente',
      '3. Se ultrapassar 81k em qualquer mes, desenquadramento eh obrigatorio',
    ],
    help_url: null,
  };
}

// ============================================================
// HANDLERS - Lucro Presumido / Real
// ============================================================

async function darf_lp(companyId, template) {
  // Generico pra IRPJ/CSLL/PIS/COFINS Lucro Presumido/Real
  const c = await getCompanyContext(companyId);
  const code = template?.code || '';
  const isQuarterly = code.startsWith('IRPJ') || code.startsWith('CSLL');
  const { start, end } = isQuarterly ? startEndOfQuarter() : previousMonth();
  const receita = await sumIncomeBetween(companyId, start, end);

  // Aliquotas Lucro Presumido (servico - 32% presuncao)
  const aliqMap = {
    IRPJ_LP: { presuncao: 0.32, aliq: 0.15, ad: { lim: 60000, taxa: 0.10 }, base: 'lucro' },
    CSLL_LP: { presuncao: 0.32, aliq: 0.09, base: 'lucro' },
    PIS_LP: { aliq: 0.0065, base: 'receita' }, // cumulativo
    COFINS_LP: { aliq: 0.03, base: 'receita' }, // cumulativo
    IRPJ_LR: { aliq: 0.15, ad: { lim: 60000, taxa: 0.10 }, base: 'lucro_real' },
    CSLL_LR: { aliq: 0.09, base: 'lucro_real' },
    PIS_LR: { aliq: 0.0165, base: 'receita_nc' }, // nao-cumulativo
    COFINS_LR: { aliq: 0.076, base: 'receita_nc' },
  };
  const cfg = aliqMap[code] || { aliq: 0.05, base: 'receita' };

  let baseCalculo = receita;
  let valor = 0;
  let detalhes = '';

  if (cfg.base === 'lucro') {
    baseCalculo = receita * (cfg.presuncao || 0.32);
    valor = baseCalculo * cfg.aliq;
    if (cfg.ad && baseCalculo > cfg.ad.lim) {
      valor += (baseCalculo - cfg.ad.lim) * cfg.ad.taxa;
      detalhes = `Adicional 10% sobre lucro acima de R$60k/trim aplicado.`;
    }
  } else if (cfg.base === 'lucro_real') {
    detalhes = 'Lucro Real exige escrituracao contabil - valor depende do LALUR.';
    baseCalculo = receita * 0.10; // fallback estimado pra mostrar algo
    valor = baseCalculo * cfg.aliq;
  } else {
    valor = receita * cfg.aliq;
  }

  const content =
`${template?.name_display || code}
${'='.repeat((template?.name_display || code).length)}
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Periodo: ${fmtBR(start)} a ${fmtBR(end)}
${isQuarterly ? 'Apuracao: trimestral' : 'Apuracao: mensal'}

CALCULO:
  Receita bruta no periodo: ${fmtBRL(receita)}
  ${cfg.presuncao ? `Presuncao aplicada: ${(cfg.presuncao * 100)}%` : ''}
  Base de calculo: ${fmtBRL(baseCalculo)}
  Aliquota: ${(cfg.aliq * 100).toFixed(2)}%
  Valor estimado: ${fmtBRL(valor)}
  ${detalhes}

CODIGO DA RECEITA (DARF):
${codigoReceita(code)}

COMO PAGAR:
1. Acessar Sicalc Web: https://sicalc.receita.economia.gov.br/sicalc/principal
2. Selecionar codigo da receita acima
3. Periodo de apuracao: ${fmtBR(start)} a ${fmtBR(end)}
4. Valor: ${fmtBRL(valor)} (validar com contador)
5. Imprimir DARF e pagar via internet banking

ATENCAO: Calculo estimado. Lucro Real exige LALUR (escrituracao contabil).
Lucro Presumido com servico = 32% presuncao. Validar com contador.`;

  return {
    format: 'guide_text',
    filename: `${code}_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content,
    summary: `${template?.name_display}: ${fmtBRL(valor)} (estimado, base ${fmtBRL(baseCalculo)})`,
    instructions: [
      '1. Validar calculo com contador (sobretudo Lucro Real)',
      '2. Acessar Sicalc Web',
      `3. Codigo receita: ${codigoReceita(code)}`,
      '4. Imprimir DARF e pagar',
    ],
    help_url: 'https://sicalc.receita.economia.gov.br/sicalc/principal',
  };
}

function codigoReceita(code) {
  const map = {
    IRPJ_LP: '2089 (IRPJ Lucro Presumido)',
    CSLL_LP: '2372 (CSLL Lucro Presumido)',
    PIS_LP: '8109 (PIS Cumulativo)',
    COFINS_LP: '2172 (COFINS Cumulativo)',
    IRPJ_LR: '2362 (IRPJ Lucro Real)',
    CSLL_LR: '6773 (CSLL Lucro Real)',
    PIS_LR: '6912 (PIS Nao-cumulativo)',
    COFINS_LR: '5856 (COFINS Nao-cumulativa)',
  };
  return map[code] || '(consultar contador)';
}

async function dctf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();
  return {
    format: 'guide_text',
    filename: `DCTF_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`DCTF - Declaracao de Debitos e Creditos Tributarios Federais
=============================================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}

Tributos a declarar (se houve recolhimento no mes):
- IRPJ
- CSLL
- PIS / COFINS
- IRRF
- IPI (se aplicavel)
- Outros tributos federais

Prazo: ate o 15o dia util do segundo mes subsequente.
(Ex: DCTF de janeiro entrega ate 15 de marco)

ATENCAO: DCTF foi substituida em parte pela DCTFWeb (que ja usa
folha eSocial + EFD-Reinf). Verifique com contador se ainda
precisa enviar DCTF tradicional ou apenas DCTFWeb.

COMO ENTREGAR:
1. Baixar Programa Gerador da DCTF (PGD) no portal da Receita
2. Importar XML do mes (gerado pelo seu sistema contabil)
3. Conferir e transmitir via Receitanet
4. Guardar recibo de entrega`,
    summary: `DCTF ${start.getMonth() + 1}/${start.getFullYear()} - verificar com contador se ainda eh exigida (DCTFWeb substitui)`,
    instructions: [
      '1. Confirmar com contador se DCTF ainda eh exigida',
      '2. Baixar PGD-DCTF',
      '3. Transmitir via Receitanet',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/servicos/declaracoes/dctf',
  };
}

async function dctfweb(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();

  const { rows: emps } = await db.query(
    `SELECT COUNT(*) AS total FROM employees WHERE company_id = $1 AND is_active = true`, [companyId]
  );
  const numFunc = parseInt(emps[0].total);

  const content =
`DCTFWeb - Declaracao de Debitos e Creditos Tributarios Federais Web
====================================================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
Funcionarios ativos: ${numFunc}

A DCTFWeb consolida automaticamente:
- INSS patronal (eSocial)
- INSS retido de funcionarios (eSocial)
- FGTS (FGTS Digital)
- Outros tributos previdenciarios

A declaracao eh GERADA AUTOMATICAMENTE no portal a partir dos
eventos enviados pelo eSocial. Voce nao precisa preencher manual:
1. Enviar folha mensal via eSocial ate dia 7 do mes subsequente
2. DCTFWeb fica disponivel no portal automaticamente
3. Conferir valores
4. Transmitir e gerar DARF (DAE)
5. Pagar ate dia 20

PORTAL: https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/dctfweb

${numFunc === 0 ? 'AVISO: Sem funcionarios ativos - DCTFWeb pode ser zerada (DCTFWeb sem movimento).' : ''}`;

  return {
    format: 'guide_text',
    filename: `DCTFWEB_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content,
    summary: numFunc === 0
      ? 'DCTFWeb sem movimento (sem funcionarios)'
      : `DCTFWeb ${start.getMonth() + 1}/${start.getFullYear()} - ${numFunc} funcionario(s)`,
    instructions: [
      '1. Garantir que folha foi enviada via eSocial ate dia 7',
      '2. Acessar portal DCTFWeb com certificado',
      '3. Conferir valores consolidados',
      '4. Transmitir e gerar DAE',
      '5. Pagar ate dia 20',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/dctfweb',
  };
}

async function ecd(companyId) {
  const c = await getCompanyContext(companyId);
  const ano = new Date().getFullYear() - 1;
  return {
    format: 'guide_text',
    filename: `ECD_${ano}.txt`,
    content:
`ECD - Escrituracao Contabil Digital (SPED Contabil)
====================================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Ano-base: ${ano}

A ECD substitui livros contabeis em papel:
- Livro Diario
- Livro Razao
- Livro Balancetes Diarios e Balancos
- Livro Auxiliar de Registro de Lancamentos
- DEMONSTRACOES financeiras (DRE, BP)

QUEM ESTA OBRIGADO:
- Lucro Real (sempre)
- Lucro Presumido (se distribuiu lucros acima do presumido)
- Imune/Isenta (se receita > R$ 4.8M no ano)

PRAZO: ultimo dia util de junho do ano subsequente.

COMO GERAR:
1. ECD eh gerada pelo seu SISTEMA CONTABIL (Dominio, Sage, Alterdata, etc)
2. O sistema exporta um arquivo .txt no layout do SPED Contabil
3. Validar no Programa Validador da Receita (PVA)
4. Assinar digitalmente com certificado A1/A3
5. Transmitir via Receitanet

ATENCAO: ECD nao eh gerada pelo Aura. Voce precisa de um sistema
contabil completo ou contador externo. Aura fornece dados-fonte
(receitas, despesas, transactions) via export CSV pra alimentar
o sistema contabil.

DICAS:
- Multa por atraso: R$ 500/mes (ME/EPP) ou R$ 1.500/mes (demais)
- Multa por nao apresentar: 0,5% sobre receita
- Backup da ECD por 5 anos`,
    summary: `ECD ${ano} - exige sistema contabil. Aura fornece dados-fonte via export.`,
    instructions: [
      '1. Verificar se empresa esta obrigada (Lucro Real ou casos especificos)',
      '2. Exportar dados do Aura (CSV de transactions) pra contador',
      '3. Contador gera ECD no sistema contabil',
      '4. Transmitir via Receitanet ate ultimo dia util de junho',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/sped-sistema-publico-de-escrituracao-digital/escrituracao-contabil-digital-ecd',
  };
}

async function ecf(companyId) {
  const c = await getCompanyContext(companyId);
  const ano = new Date().getFullYear() - 1;
  return {
    format: 'guide_text',
    filename: `ECF_${ano}.txt`,
    content:
`ECF - Escrituracao Contabil Fiscal
===================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Ano-base: ${ano}

A ECF consolida apuracao de IRPJ + CSLL anuais:
- LALUR (Livro de Apuracao do Lucro Real) digital
- e-LALUR
- Demonstracoes do Resultado
- Adicoes/exclusoes do lucro tributavel

QUEM ESTA OBRIGADO:
- Todas as PJ tributadas pelo Lucro Real, Presumido ou Arbitrado
- Imune/isenta com receita > R$4.8M

PRAZO: ultimo dia util de julho do ano subsequente.

COMO GERAR:
1. ECF eh gerada pelo SISTEMA CONTABIL
2. Importa dados da ECD (precisa ECD entregue antes)
3. Calcula IRPJ + CSLL devidos no ano
4. Valida no PVA (Programa Validador)
5. Assina digital + transmite via Receitanet

PRE-REQUISITO: ECD entregue (junho/ano).

ATENCAO: Aura nao gera ECF. Aura fornece dados-fonte pro sistema
contabil que produz a ECF.

PENALIDADES:
- Atraso: R$1.500 a R$1.500.000 conforme receita
- Inexata/incompleta: 3% sobre valor omitido (minimo R$100)`,
    summary: `ECF ${ano} - exige sistema contabil + ECD entregue antes.`,
    instructions: [
      '1. Garantir ECD entregue antes (prazo junho)',
      '2. Exportar dados-fonte do Aura',
      '3. Contador gera ECF no sistema contabil',
      '4. Transmitir via Receitanet ate ultimo dia util de julho',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/sped-sistema-publico-de-escrituracao-digital/escrituracao-contabil-fiscal-ecf',
  };
}

async function efd_contrib(companyId) {
  const c = await getCompanyContext(companyId);
  const { start } = previousMonth();
  const receita = await sumIncomeBetween(companyId, start, new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59));

  return {
    format: 'guide_text',
    filename: `EFD_CONTRIB_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`EFD-Contribuicoes (PIS/COFINS)
================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
Receita do mes: ${fmtBRL(receita)}

EFD-Contribuicoes eh entrega digital obrigatoria pra:
- Lucro Real (sempre, mensal)
- Lucro Presumido (anual ate 2024, mensal a partir de 2025)
- Imune/isenta com obrigacoes

Substitui DACON. Consolida:
- PIS apurado
- COFINS apurado
- Creditos (apenas Lucro Real / nao-cumulativo)
- Receita bruta
- Compras / despesas que geram credito

PRAZO: ate 10o dia util do segundo mes subsequente.
(Ex: janeiro entrega ate 10o dia util de marco)

COMO GERAR:
1. Sistema contabil gera arquivo .txt no layout EFD-Contribuicoes
2. Validar no PVA EFD-Contribuicoes
3. Assinar com certificado digital
4. Transmitir via Receitanet

ATENCAO: Aura nao gera EFD-Contribuicoes - exige integracao com
sistema contabil. Forneca relatorio de receitas (CSV transactions)
ao contador.

PENALIDADES:
- Atraso: 0.02% por dia sobre operacoes do mes (max 1%)
- Nao apresentar: R$1.500 a R$1.500.000`,
    summary: `EFD-Contribuicoes ${start.getMonth() + 1}/${start.getFullYear()} - receita ${fmtBRL(receita)}`,
    instructions: [
      '1. Exportar receitas/despesas do Aura',
      '2. Contador gera EFD-Contribuicoes no sistema contabil',
      '3. Validar no PVA',
      '4. Transmitir ate 10o dia util do segundo mes subsequente',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/sped-sistema-publico-de-escrituracao-digital/escrituracao-fiscal-digital-efd/efd-contribuicoes',
  };
}

async function iss_nfse(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = previousMonth();
  const receita = await sumIncomeBetween(companyId, start, end);
  const aliqIss = 0.05; // 5% padrao - varia por municipio
  const issEstimado = receita * aliqIss;

  const content = JSON.stringify({
    cnpj: c?.cnpj,
    razao_social: c?.legal_name || c?.trade_name,
    competencia: `${start.getMonth() + 1}/${start.getFullYear()}`,
    receita_servico_mes: receita,
    aliquota_iss_estimada: '5% (varia 2-5% por municipio)',
    iss_estimado: issEstimado,
    aviso: 'ISS eh municipal - aliquota varia. Sao Paulo: 2-5% conforme atividade. Verifique no portal NFS-e.',
    codigo_servico_odonto: '4.01 (Servicos medicos em geral) - confira no seu municipio',
  }, null, 2);

  return {
    format: 'json',
    filename: `ISS_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.json`,
    content,
    summary: `ISS estimado ${fmtBR(start)}: ${fmtBRL(issEstimado)} sobre ${fmtBRL(receita)}`,
    instructions: [
      '1. Acessar portal NFS-e do seu municipio',
      '2. Login com e-CNPJ',
      '3. Conferir notas emitidas no mes',
      '4. ISS pode ser pago via guia gerada pelo proprio portal',
      '5. Vencimento padrao: dia 15 do mes subsequente',
    ],
    help_url: null,
  };
}

// ============================================================
// HANDLERS - Compliance Odonto
// ============================================================

async function sngpc_inventario(companyId) {
  const c = await getCompanyContext(companyId);
  const today = new Date();
  const csv =
`CNES;${c?.cnes_number || 'CADASTRAR_CNES'};Mes;${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}
Tipo;Medicamento;DCB/DCI;Apresentacao;Concentracao;Quantidade_inicio;Entradas;Saidas;Quantidade_fim;Lote;Validade
ENTRADA;Lidocaina+Epinefrina;LIDOCAINA;Tubete;2%+1:200000;0;0;0;0;;
ENTRADA;Articaina+Epinefrina;ARTICAINA;Tubete;4%+1:100000;0;0;0;0;;
SAIDA;Diazepam;DIAZEPAM;Comprimido;5mg;0;0;0;0;;`;

  return {
    format: 'csv',
    filename: `SNGPC_INVENTARIO_${today.getFullYear()}_${String(today.getMonth() + 1).padStart(2, '0')}.csv`,
    content: csv,
    summary: 'CSV inventario mensal SNGPC - preencha quantidades e movimentos do mes',
    instructions: [
      '1. Abrir o CSV em Excel ou similar',
      '2. Preencher quantidades de inicio/entrada/saida/fim de cada medicamento',
      '3. Adicionar linhas pra outros controlados que voce usa',
      '4. Acessar https://sngpc.anvisa.gov.br/ com certificado',
      '5. Importar arquivo no formato XML SNGPC (converter via portal Anvisa)',
    ],
    help_url: 'https://sngpc.anvisa.gov.br/',
  };
}

async function cro_anuidade(companyId) {
  const c = await getCompanyContext(companyId);
  const valorPj = 1100;
  const valorRt = 870;
  const today = new Date();
  return {
    format: 'guide_text',
    filename: `CRO_ANUIDADE_${today.getFullYear()}.txt`,
    content:
`Anuidade CRO ${today.getFullYear()}
=============================
Estado: ${c?.cro_state || 'CADASTRAR_UF'}
Inscricao PJ: ${c?.cro_pj_number || 'CADASTRAR_INSCRICAO'}
Inscricao RT: ${c?.cro_rt_number || 'CADASTRAR_RT'}

Valores estimados (varia por estado, confira no portal):
- Anuidade Pessoa Juridica (clinica): ${fmtBRL(valorPj)}
- Anuidade Responsavel Tecnico (dentista): ${fmtBRL(valorRt)}
- Total estimado: ${fmtBRL(valorPj + valorRt)}

Vencimento: 31 de marco de ${today.getFullYear()}.

Como pagar:
1. Acessar portal do CRO do estado (ex CRO-SP: cro-sp.org.br)
2. Logar com CPF/CRO + senha
3. Emitir guia da anuidade PJ + RT
4. Pagar via boleto/PIX antes de 31/03

ATENCAO: pagamento em atraso gera multa + juros. Inadimplencia
impede emissao de NFS-e e responsabilidade tecnica.`,
    summary: `Anuidade CRO ${today.getFullYear()}: ${fmtBRL(valorPj + valorRt)} estimado (PJ + RT). Vencimento 31/03.`,
    instructions: [
      '1. Acessar portal do CRO do seu estado',
      '2. Logar com CPF + senha',
      '3. Emitir guia PJ + RT',
      '4. Pagar antes de 31/03',
    ],
    help_url: c?.cro_state ? `https://cro-${c.cro_state.toLowerCase()}.org.br/` : 'https://cfo.org.br/',
  };
}

async function alvara_vigilancia(companyId) {
  const c = await getCompanyContext(companyId);
  const exp = c?.vigilancia_alvara_expires_at ? new Date(c.vigilancia_alvara_expires_at) : null;
  const days = exp ? Math.ceil((exp.getTime() - Date.now()) / 86400000) : null;
  const status = days == null
    ? 'Data nao cadastrada'
    : days < 0 ? `VENCIDO ha ${Math.abs(days)} dias` : `Vence em ${days} dias`;

  return {
    format: 'guide_text',
    filename: `ALVARA_VIGILANCIA.txt`,
    content:
`Alvara da Vigilancia Sanitaria
================================
Razao Social: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}
Endereco: ${c?.address || 'CADASTRAR'}
Numero do alvara: ${c?.vigilancia_alvara_number || 'NAO CADASTRADO'}
Validade: ${exp ? fmtBR(exp) : 'NAO CADASTRADA'}
Status: ${status}

Como renovar:
1. Acessar o portal da Vigilancia Sanitaria do seu municipio
2. Login com CNPJ + senha
3. Solicitar renovacao do alvara
4. Pagar taxa municipal
5. Aguardar inspecao
6. Receber novo alvara - cadastrar nova data de validade no Aura

Documentos comuns exigidos:
- Contrato social atualizado
- Comprovante CRO ativo (clinica + RT)
- CNES atualizado
- PCMSO + PGR vigentes (se tem funcionario)
- Comprovante de IPTU pago
- Inspecao do imovel`,
    summary: `Alvara: ${status}. Renove no portal municipal.`,
    instructions: [
      '1. Acessar portal Vigilancia Sanitaria do municipio',
      '2. Solicitar renovacao com 60 dias de antecedencia',
      '3. Anexar documentos (contrato social, CRO, CNES, PCMSO/PGR, IPTU)',
      '4. Pagar taxa e aguardar inspecao',
      '5. Cadastrar nova data quando receber novo alvara',
    ],
    help_url: 'https://www.gov.br/anvisa/pt-br',
  };
}

async function pcmso(companyId) {
  const c = await getCompanyContext(companyId);
  const { rows: emps } = await db.query(
    'SELECT COUNT(*) AS total FROM employees WHERE company_id = $1 AND is_active = true', [companyId]
  );
  const totalFunc = parseInt(emps[0].total);

  return {
    format: 'guide_text',
    filename: `PCMSO_${new Date().getFullYear()}.txt`,
    content:
`PCMSO - Programa de Controle Medico de Saude Ocupacional (NR-7)
================================================================
Empresa: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}
CNAE: ${c?.cnae_code || ''} (Atividade odontologica)
Funcionarios ativos: ${totalFunc}
Grau de risco: 2 (CNAE 8630-5/04)

Conteudo obrigatorio do PCMSO:
1. Identificacao da empresa
2. Indicacao do medico coordenador (medico do trabalho)
3. Avaliacoes clinicas obrigatorias:
   - Admissional (antes do funcionario comecar)
   - Periodicas (anual ou bianual conforme idade)
   - Retorno ao trabalho (apos afastamento > 30 dias)
   - Mudanca de funcao
   - Demissional
4. Exames complementares por funcao:
   - Auxiliar de saude bucal (TSB/ASB): hemograma, hepatite B, tetano
   - Dentista: hepatite B, hepatite C, HIV
5. Procedimentos em caso de acidentes (perfurocortante, etc)
6. Periodicidade do PCMSO: ANUAL

Quem elabora:
- Medico do trabalho registrado no CRM com especializacao em saude ocupacional
- Custo medio R$300-800 por elaboracao + R$80-150 por exame admissional/periodico

Documentacao mantida na clinica:
- ASO (Atestado de Saude Ocupacional) de cada funcionario
- Relatorio anual com estatisticas
- Plano de acao corretiva`,
    summary: `PCMSO ${new Date().getFullYear()} - ${totalFunc} funcionario(s) ativo(s). Contrate medico do trabalho.`,
    instructions: [
      '1. Contratar medico do trabalho (CRM + especializacao)',
      '2. Ele elabora PCMSO baseado no CNAE 8630-5/04',
      '3. Realizar exames admissionais/periodicos por funcionario',
      '4. Manter ASOs arquivados na clinica por 20 anos',
      '5. Renovar PCMSO anualmente',
    ],
    help_url: 'https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/seguranca-e-saude-no-trabalho/normas-regulamentadoras/nr-07.pdf',
  };
}

async function pgr(companyId) {
  const c = await getCompanyContext(companyId);
  const { rows: emps } = await db.query(
    `SELECT name, role_label FROM employees WHERE company_id = $1 AND is_active = true`, [companyId]
  );

  return {
    format: 'guide_text',
    filename: `PGR_${new Date().getFullYear()}.txt`,
    content:
`PGR - Programa de Gerenciamento de Riscos (NR-1)
==================================================
Empresa: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}
CNAE: ${c?.cnae_code || ''} (Atividade odontologica)
Funcionarios: ${emps.length}

CONTEUDO OBRIGATORIO DO PGR:
1. Inventario de Riscos
   - Riscos fisicos: ruidos compressor, vibracao, temperatura
   - Riscos quimicos: mercurio amalgama, anestesicos, eter
   - Riscos biologicos: HIV, hepatite B/C, herpes, COVID-19, tuberculose
   - Riscos ergonomicos: postura prolongada, repetitividade
   - Riscos acidentes: perfurocortante, queimadura

2. Plano de Acao
   - Medidas administrativas (treinamento, protocolos)
   - Medidas de protecao coletiva (autoclave, exaustor)
   - EPI obrigatorios por funcao:
     * Dentista: oculos protecao, mascara N95/PFF2, luvas, jaleco impermeavel, gorro
     * Auxiliar: oculos, mascara, luvas, jaleco
     * Recepcao: mascara cirurgica em surto

3. Avaliacao e Monitoramento Continuo

PERIODICIDADE: revisao ANUAL (ou quando houver mudanca significativa)

QUEM ELABORA:
- Engenheiro de Seguranca ou Tecnico em Seguranca do Trabalho
- Custo medio: R$500-1500 (elaboracao + revisao anual)

INTEGRACAO COM PCMSO:
- PGR identifica os riscos
- PCMSO trata da saude ocupacional dos funcionarios expostos
- Devem estar coerentes - mesmos riscos -> mesmas medidas

PROFISSIONAIS LISTADOS:
${emps.map((e, i) => `${i + 1}. ${e.name} (${e.role_label || 'sem funcao'})`).join('\n') || '(sem funcionarios cadastrados)'}

DOCUMENTOS COMPLEMENTARES:
- Ficha de EPI de cada funcionario
- Comprovantes de treinamento NR-32 (saude)
- Plano de emergencia (incendio, perfurocortante)
- Mapa de risco impresso e visivel`,
    summary: `PGR ${new Date().getFullYear()} - ${emps.length} funcionario(s). Contrate engenheiro/tecnico de seguranca.`,
    instructions: [
      '1. Contratar engenheiro ou tecnico de seguranca',
      '2. Levantar inventario de riscos (fisicos, quimicos, biologicos, etc)',
      '3. Definir plano de acao + EPI por funcao',
      '4. Treinar funcionarios em NR-32 (saude)',
      '5. Revisar PGR anualmente',
    ],
    help_url: 'https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/seguranca-e-saude-no-trabalho/normas-regulamentadoras/nr-1.pdf',
  };
}

async function livro_receituario(companyId) {
  const c = await getCompanyContext(companyId);
  const today = new Date();

  return {
    format: 'guide_text',
    filename: `LIVRO_RECEITUARIO_${today.getFullYear()}.txt`,
    content:
`Livro de Registro Especifico de Substancias Sujeitas a Controle Especial
==========================================================================
Clinica: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}
CNES: ${c?.cnes_number || 'NAO CADASTRADO'}
Ano: ${today.getFullYear()}

EXIGENCIA: Portaria 344/98 SVS/MS art. 64

CONTEUDO MINIMO DO LIVRO (preencher manualmente ou planilha):
- Numero sequencial da receita
- Data de prescricao
- Nome do paciente
- CPF/RG do paciente
- Endereco do paciente
- Telefone do paciente
- Substancia prescrita (DCB/DCI)
- Concentracao + apresentacao
- Quantidade prescrita
- Posologia
- Identificacao do prescritor (nome + CRO)
- Data da dispensacao (se aplicavel)
- Numero da nota de compra do medicamento

LISTAS QUE EXIGEM ESCRITURACAO:
- A1, A2, A3 (entorpecentes)
- B1, B2 (psicotropicos)
- C1, C2, C3, C4, C5 (outras controladas)
- D1 (precursoras)

PERIODICIDADE: registrar TODA receita controlada na hora da prescricao
GUARDA: minimo 5 anos

ALTERNATIVA DIGITAL:
Pode ser substituido por sistema informatizado APROVADO pela ANVISA,
desde que com backup regular e proibicao de exclusao.

CHECK MENSAL:
[ ] Conferir todas receitas controladas emitidas no mes
[ ] Cruzar com inventario SNGPC
[ ] Validar saldo de cada medicamento
[ ] Apurar discrepancias com a equipe
[ ] Rubricar pagina mensal do livro

ATENCAO: ausencia ou irregularidade no Livro acarreta:
- Multa Anvisa R$2.000 a R$1.500.000
- Suspensao do alvara sanitario
- Responsabilidade civil/criminal do RT`,
    summary: `Checklist mensal do Livro Receituario - manter registro de todas controladas prescritas`,
    instructions: [
      '1. Imprimir/baixar livro fisico OU usar sistema aprovado',
      '2. Registrar TODA receita controlada na hora',
      '3. Mensalmente cruzar com inventario SNGPC',
      '4. Manter por 5 anos no minimo',
      '5. RT eh responsavel legal pela escrituracao',
    ],
    help_url: 'https://www.gov.br/anvisa/pt-br/assuntos/regulamentacao/legislacao/portaria-svs-ms-no-344-de-12-de-maio-de-1998',
  };
}

// ============================================================
// HANDLERS - Pessoa Fisica + IRPF
// ============================================================

async function irpf_simples(companyId) {
  const c = await getCompanyContext(companyId);
  const ano = new Date().getFullYear();
  const anoBase = ano - 1;

  const start = new Date(anoBase, 0, 1);
  const end = new Date(anoBase, 11, 31, 23, 59, 59);
  const { rows: prol } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE company_id = $1 AND type = 'expense'
       AND (category = 'pro_labore' OR description ILIKE '%pro-labore%' OR description ILIKE '%prolabore%')
       AND created_at >= $2 AND created_at <= $3`,
    [companyId, start, end]
  );
  const totalProLabore = parseFloat(prol[0].total);
  const totalReceita = await sumIncomeBetween(companyId, start, end);
  const lucroDistribuivel = totalReceita * 0.32;

  return {
    format: 'guide_text',
    filename: `IRPF_${anoBase}_orientacao.txt`,
    content:
`Imposto de Renda Pessoa Fisica ${ano} (ano-base ${anoBase})
==============================================================
Empresa origem: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}

QUEM PRECISA DECLARAR:
- Recebeu rendimentos tributaveis acima de R$30.639,90 no ano
- Recebeu rendimentos isentos acima de R$200.000
- Tinha bens > R$800.000 em 31/12/${anoBase}
- Eh socio/titular de empresa com receita > R$130.000
- Vendeu imovel/acoes com lucro

DADOS DA EMPRESA PRA DECLARACAO DOS SOCIOS:
- Pro-labore pago em ${anoBase}: ${fmtBRL(totalProLabore)}
- Receita bruta da PJ em ${anoBase}: ${fmtBRL(totalReceita)}
- Lucro presumido (32% receita - estimativa): ${fmtBRL(lucroDistribuivel)}
- Lucro distribuido aos socios (varia conforme contrato social)

INFORME DE RENDIMENTOS:
- Pro-labore: TRIBUTAVEL (lancar em "Rendimentos Tributaveis Recebidos PJ")
- Lucros distribuidos: ISENTO (lancar em "Rendimentos Isentos - Lucros e dividendos")
- Pagamentos a profissionais (dentistas freela, prestadores): cada um declara o que recebeu

ENTREGAR ATE: 31 de maio de ${ano}

COMO DECLARAR:
1. Baixar programa IRPF ${ano} no site da Receita
2. Importar declaracao do ano anterior (se existir)
3. Lancar rendimentos PJ (pro-labore + lucros)
4. Lancar bens (imoveis, veiculos, conta corrente, investimentos)
5. Lancar despesas dedutiveis (educacao, saude, dependentes, INSS, previdencia privada)
6. Conferir + transmitir

DEDUCOES IMPORTANTES PRO DENTISTA:
- Cursos de pos-graduacao/especializacao (ate teto)
- Plano de saude pessoal
- Mensalidade de filhos em escola/faculdade (ate teto)
- Doacoes a fundos da crianca/idoso (ate 6% imposto devido)
- INSS pago como contribuinte individual

ATENCAO:
- Se PJ adotou Lucro Presumido: distribuicao acima do presumido
  (32% receita) eh TRIBUTAVEL no IRPF
- Sempre confirme com contador antes de transmitir
- Recibo de entrega vale como comprovante`,
    summary: `IRPF ${ano} (ano-base ${anoBase}). Pro-labore pago: ${fmtBRL(totalProLabore)}.`,
    instructions: [
      '1. Reunir informe de rendimentos (PJ envia ao socio)',
      '2. Baixar programa IRPF',
      '3. Lancar rendimentos PJ (pro-labore tributavel + lucros isentos)',
      '4. Lancar bens, deducoes (saude, educacao, INSS, previdencia)',
      '5. Transmitir ate 31/05',
    ],
    help_url: 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda',
  };
}

// ============================================================
// HANDLERS - eSocial + Folha
// ============================================================

async function dae_esocial(companyId) {
  const c = await getCompanyContext(companyId);
  const { start } = previousMonth();
  const { rows: emps } = await db.query(
    `SELECT COUNT(*) AS total FROM employees WHERE company_id = $1 AND is_active = true`, [companyId]
  );
  const numFunc = parseInt(emps[0].total);
  const folhaMensal = await sumPayrollBetween(companyId, start, new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59));

  const inssPatronal = folhaMensal * 0.20;
  const rat = folhaMensal * 0.02;
  const terceiros = folhaMensal * 0.058;
  const totalDae = inssPatronal + rat + terceiros;

  return {
    format: 'guide_text',
    filename: `DAE_ESOCIAL_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`DAE - Documento de Arrecadacao do eSocial
============================================
CNPJ: ${c?.cnpj || ''}
Razao Social: ${c?.legal_name || c?.trade_name || ''}
Competencia: ${start.getMonth() + 1}/${start.getFullYear()}
Funcionarios ativos: ${numFunc}
Folha bruta estimada: ${fmtBRL(folhaMensal)}

CALCULO ESTIMADO:
  INSS patronal (20%):       ${fmtBRL(inssPatronal)}
  RAT/SAT (2% - risco 2):    ${fmtBRL(rat)}
  Terceiros (5.8% - SESI etc): ${fmtBRL(terceiros)}
  ------------------------
  TOTAL DAE:                 ${fmtBRL(totalDae)}

ATENCAO:
- Valor real eh consolidado pela DCTFWeb apos eSocial mensal
- INSS retido de funcionarios (8-14%) tambem entra no DAE
- FGTS (8%) eh recolhido a parte via FGTS Digital

COMO PAGAR:
1. Garantir que folha foi enviada via eSocial ate dia 7
2. Acessar portal DCTFWeb com certificado
3. DAE eh GERADO AUTOMATICAMENTE apos transmissao
4. Imprimir/baixar guia
5. Pagar via internet banking ate dia 20

PORTAL: https://www.gov.br/esocial/pt-br

${numFunc === 0 ? 'AVISO: Sem funcionarios ativos - sem DAE eSocial este mes.' : ''}`,
    summary: numFunc === 0
      ? 'DAE sem movimento (sem funcionarios)'
      : `DAE estimado: ${fmtBRL(totalDae)} (${numFunc} func, folha ${fmtBRL(folhaMensal)})`,
    instructions: [
      '1. Enviar folha via eSocial ate dia 7',
      '2. Acessar portal DCTFWeb',
      '3. DAE consolidado apos transmissao',
      '4. Pagar ate dia 20',
    ],
    help_url: 'https://www.gov.br/esocial/pt-br',
  };
}

async function folha_mei(companyId) {
  const c = await getCompanyContext(companyId);
  const { start } = previousMonth();
  const { rows: emps } = await db.query(
    `SELECT name, role_label, salary, registration_number FROM employees
     WHERE company_id = $1 AND is_active = true ORDER BY name`,
    [companyId]
  );
  if (emps.length === 0) {
    return {
      format: 'guide_text',
      filename: `FOLHA_MEI_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
      content: 'Sem funcionarios ativos - folha sem movimento este mes.',
      summary: 'Sem funcionarios cadastrados',
      instructions: ['1. Cadastrar funcionarios em Equipe -> Funcionarios'],
      help_url: null,
    };
  }

  const linhas = emps.map(e => {
    const sal = parseFloat(e.salary) || 0;
    const inssFunc = sal * 0.08;
    const fgts = sal * 0.08;
    const inssEmp = sal * 0.03;
    return {
      nome: e.name,
      cargo: e.role_label || '-',
      salario_bruto: sal,
      inss_funcionario: inssFunc,
      salario_liquido: sal - inssFunc,
      inss_empresa_3pct: inssEmp,
      fgts_8pct: fgts,
    };
  });

  const totais = linhas.reduce((acc, l) => ({
    bruto: acc.bruto + l.salario_bruto,
    inssEmp: acc.inssEmp + l.inss_empresa_3pct,
    fgts: acc.fgts + l.fgts_8pct,
  }), { bruto: 0, inssEmp: 0, fgts: 0 });

  const content =
`Folha de Pagamento MEI - ${start.getMonth() + 1}/${start.getFullYear()}
=====================================================
CNPJ: ${c?.cnpj || ''}
Funcionarios: ${linhas.length} (limite MEI: 1)

${linhas.map((l, i) => `
${i + 1}. ${l.nome} - ${l.cargo}
   Salario bruto: ${fmtBRL(l.salario_bruto)}
   INSS funcionario (8%): ${fmtBRL(l.inss_funcionario)}
   Salario liquido: ${fmtBRL(l.salario_liquido)}
   INSS empresa MEI (3%): ${fmtBRL(l.inss_empresa_3pct)}
   FGTS (8%): ${fmtBRL(l.fgts_8pct)}`).join('\n')}

TOTAIS DA EMPRESA:
  Folha bruta: ${fmtBRL(totais.bruto)}
  INSS patronal MEI 3%: ${fmtBRL(totais.inssEmp)}
  FGTS 8%: ${fmtBRL(totais.fgts)}
  TOTAL CUSTO: ${fmtBRL(totais.bruto + totais.inssEmp + totais.fgts)}

ATENCAO MEI:
- Limite: 1 funcionario (no maximo)
- Salario maximo: minimo ou piso da categoria
- Patronal: 3% (versus 20% no Simples Nacional)
- Eh OBRIGATORIO usar eSocial

COMO PAGAR:
1. Enviar folha via eSocial Domestico/MEI ate dia 7
2. Sistema gera DAE automatico
3. Pagar INSS/FGTS via DAE ate dia 7 (FGTS) e 20 (INSS)
4. Holerite assinado pelo funcionario`;

  return {
    format: 'guide_text',
    filename: `FOLHA_MEI_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content,
    summary: `Folha MEI ${start.getMonth() + 1}: ${linhas.length} func | bruto ${fmtBRL(totais.bruto)} | DAE ~${fmtBRL(totais.inssEmp + totais.fgts)}`,
    instructions: [
      '1. Conferir salarios e horas trabalhadas',
      '2. Imprimir holerite e coletar assinatura',
      '3. Enviar folha via eSocial ate dia 7',
      '4. Pagar DAE INSS+FGTS conforme calendario',
    ],
    help_url: 'https://www.gov.br/esocial/pt-br',
  };
}

async function esocial_admissao(companyId) {
  const c = await getCompanyContext(companyId);
  return {
    format: 'guide_text',
    filename: `ESOCIAL_ADMISSAO_TEMPLATE.txt`,
    content:
`Checklist de Admissao via eSocial
====================================
CNPJ: ${c?.cnpj || ''}

DOCUMENTOS DO FUNCIONARIO:
[ ] CPF
[ ] RG ou CNH
[ ] Carteira de Trabalho (CTPS)
[ ] PIS/PASEP/NIT
[ ] Comprovante de residencia
[ ] Titulo de eleitor
[ ] Certificado de reservista (homens)
[ ] Comprovante de escolaridade
[ ] Certidao de casamento (se aplicavel)
[ ] CPF dos dependentes
[ ] Carteira de vacinacao em dia

EVENTOS ESOCIAL OBRIGATORIOS:
1. S-2200 (Cadastramento Inicial e Admissao)
   - Antes do funcionario comecar a trabalhar
   - Inclui dados pessoais, contrato, valor remuneracao

2. S-2210 (Comunicacao de Acidente de Trabalho)
   - Quando aplicavel

3. S-1200 (Remuneracao Trabalhador)
   - Mensal - eh a folha enviada

PRAZOS CRITICOS:
- S-2200: ate 1 dia antes do inicio das atividades
- Multa por nao envio: R$1.000 + R$200 por funcionario

EXAMES OBRIGATORIOS ANTES DA ADMISSAO:
[ ] ASO admissional (Atestado de Saude Ocupacional)
[ ] Hepatite B (vacina + sorologia)
[ ] Tetano em dia
[ ] Hemograma (auxiliar/dentista)
[ ] HIV (dentista)

COMO ENVIAR:
1. Acessar https://www.gov.br/esocial/pt-br
2. Login com certificado digital ou GOV.BR
3. Aba Empregador > Empregados > Admissao
4. Preencher formulario S-2200
5. Validar e enviar
6. Salvar recibo

DICAS PRATICAS:
- Use sistema de folha integrado ao eSocial (Domingos, Sage, etc)
- Mantem backup do envio por 5 anos
- Holerite mensal eh OBRIGATORIO assinado pelo funcionario`,
    summary: 'Checklist de admissao via eSocial - documentos, eventos, prazos',
    instructions: [
      '1. Reunir documentos do funcionario',
      '2. Realizar ASO admissional ANTES da admissao',
      '3. Enviar evento S-2200 ate 1 dia antes',
      '4. Enviar S-1200 mensal junto com folha',
    ],
    help_url: 'https://www.gov.br/esocial/pt-br',
  };
}

// ============================================================
// HANDLERS - NFE + CNES (mantidos do PR38)
// ============================================================

async function nfe_emit(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = startEndOfMonth();
  const { rows: pendentes } = await db.query(
    `SELECT t.id, t.amount, t.created_at, t.description, c.name AS customer_name
     FROM transactions t
     LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.company_id = $1 AND t.type = 'income'
       AND t.created_at >= $2 AND t.created_at <= $3
     ORDER BY t.created_at`,
    [companyId, start, end]
  );

  return {
    format: 'guide_text',
    filename: `NFSE_PENDENTES_${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}.txt`,
    content:
`Notas Fiscais de Servico - Pendentes ${start.getMonth() + 1}/${start.getFullYear()}
===============================================================
Empresa: ${c?.legal_name || c?.trade_name || ''}
CNPJ: ${c?.cnpj || ''}
Total de receitas no mes: ${pendentes.length}

${pendentes.length === 0 ? 'Sem receitas registradas no mes.' :
pendentes.map((p, i) => `${i + 1}. ${fmtBR(p.created_at)} - ${p.customer_name || 'Cliente'} - ${fmtBRL(p.amount)}\n   Descricao: ${p.description || '(sem descricao)'}`).join('\n\n')}

Como emitir NFS-e:
1. Acessar portal de NFS-e do seu municipio (Sao Paulo: nfse.prefeitura.sp.gov.br)
2. Logar com certificado digital (e-CNPJ)
3. Emitir uma NFS-e por servico prestado
4. Codigo de servico: 4.01 (servico medico em geral) ou especifico do municipio
5. ISS recolhido conforme aliquota municipal (geralmente 2-5%)`,
    summary: `${pendentes.length} receita(s) no mes - emitir NFS-e por cada paciente atendido.`,
    instructions: [
      '1. Acessar portal NFS-e do municipio',
      '2. Logar com e-CNPJ',
      '3. Emitir uma NFS-e pra cada receita do mes',
      '4. Codigo de servico 4.01 ou similar (odonto)',
      '5. Recolher ISS via DAS (Simples) ou guia propria (Presumido/Real)',
    ],
    help_url: null,
  };
}

async function cnes_update(companyId) {
  const c = await getCompanyContext(companyId);
  const { rows: emps } = await db.query(
    `SELECT name, role_label, registration_number FROM employees WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );

  const content = JSON.stringify({
    estabelecimento: {
      cnes: c?.cnes_number || null,
      cnpj: c?.cnpj,
      razao_social: c?.legal_name || c?.trade_name,
      endereco: c?.address,
    },
    profissionais: emps.map(e => ({
      nome: e.name,
      cargo: e.role_label,
      registro_conselho: e.registration_number || null,
    })),
    aviso: 'Atualize no portal CNES caso lista esteja desatualizada.',
  }, null, 2);

  return {
    format: 'json',
    filename: `CNES_${c?.cnes_number || 'novo'}.json`,
    content,
    summary: `CNES ${c?.cnes_number || '(nao cadastrado)'} - ${emps.length} profissional(is).`,
    instructions: [
      '1. Acessar https://cnes.datasus.gov.br/',
      '2. Login com CNPJ + senha',
      '3. Aba "Profissionais" - conferir lista contra o JSON acima',
      '4. Adicionar/remover conforme mudancas no quadro',
    ],
    help_url: 'https://cnes.datasus.gov.br/',
  };
}

// ============================================================
// FALLBACK generico - qualquer code sem handler implementado
// ============================================================
async function fallbackGeneric(companyId, code, template) {
  return {
    format: template?.report_format || 'guide_text',
    filename: `${code}_orientacao.txt`,
    content:
`${template?.name_display || code}
=============================
${template?.description || ''}

Acao do user: ${template?.user_action || '(nao definida)'}
Tempo estimado: ${template?.time_estimate || '?'}
Aura faz: ${template?.aura_action || '(geramos lembrete)'}

Detalhamento automatico ainda nao disponivel pra esta obrigacao.
Por enquanto siga o passo a passo manual abaixo:

${template?.user_action || 'Consulte seu contador ou portal oficial.'}`,
    summary: `${template?.name_display || code} - relatorio detalhado em desenvolvimento.`,
    instructions: [template?.user_action || 'Consulte portal oficial'],
    help_url: template?.report_help_url || null,
  };
}

// ============================================================
// REGISTRY + main entrypoint
// ============================================================
const HANDLERS = {
  // Simples Nacional
  das_sn_darf,
  pgdas_d,
  das_mei,
  defis,
  fator_r,
  dasn_simei,
  mei_limit,
  // Lucro Presumido / Real
  darf_lp,
  dctf,
  dctfweb,
  ecd,
  ecf,
  efd_contrib,
  iss_nfse,
  // Compliance odonto
  sngpc_inventario,
  cro_anuidade,
  alvara_vigilancia,
  pcmso,
  pgr,
  livro_receituario,
  // Pessoa fisica
  irpf_simples,
  // eSocial / folha
  dae_esocial,
  folha_mei,
  esocial_admissao,
  // Outros
  nfe_emit,
  cnes_update,
};

async function generateReport(companyId, code) {
  const { rows } = await db.query(
    'SELECT * FROM obligations_templates WHERE code = $1 LIMIT 1', [code]
  );
  if (!rows.length) throw new Error(`Obrigacao ${code} nao encontrada`);
  const template = rows[0];
  const endpoint = template.report_endpoint;

  const handler = HANDLERS[endpoint] || (() => fallbackGeneric(companyId, code, template));
  const report = await handler(companyId, template);

  return {
    code,
    name: template.name_display,
    description: template.description,
    generated_at: new Date().toISOString(),
    ...report,
  };
}

module.exports = { generateReport, HANDLERS };
