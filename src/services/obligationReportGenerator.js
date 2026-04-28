// ============================================================
// AURA. — obligationReportGenerator (PR38, 2026-04-28)
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
// Implementacao inicial: 9 handlers reais (PoC) + fallback generico.
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

// ============================================================
// HANDLERS (9 reais + fallback)
// ============================================================

async function das_sn_darf(companyId) {
  const c = await getCompanyContext(companyId);
  const { start, end } = startEndOfMonth(new Date(new Date().setMonth(new Date().getMonth() - 1)));
  const { rows: receitaRows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE company_id = $1 AND type = 'income' AND created_at >= $2 AND created_at <= $3`,
    [companyId, start, end]
  );
  const receita = parseFloat(receitaRows[0].total);
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
  return das_sn_darf(companyId);
}

async function das_mei(companyId) {
  const c = await getCompanyContext(companyId);
  const valorMensal = 75.90; // 2026 referencial - INSS 5% + ISS 5 (servico)
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

async function sngpc_inventario(companyId) {
  // Gera CSV com inventario do mes - lista de medicamentos controlados e movimentos.
  // Como nao temos tabela dental_medicamentos_controlados ainda, usamos placeholder
  // que orienta o user a preencher manualmente OU integrar quando tivermos a tabela.
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
  const valorPj = 1100; // Estimativa media 2026
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
   (geralmente prefeitura.gov.br ou portal especifico)
2. Login com CNPJ + senha
3. Solicitar renovacao do alvara
4. Pagar taxa municipal
5. Aguardar inspecao (pode demorar dias/semanas)
6. Receber novo alvara - cadastrar nova data de validade no Aura

Documentos comuns exigidos:
- Contrato social atualizado
- Comprovante CRO ativo (clinica + RT)
- CNES atualizado
- PCMSO + PGR vigentes (se tem funcionario)
- Comprovante de IPTU pago
- Inspecao do imovel (estrutura fisica)`,
    summary: `Alvara: ${status}. Renove no portal municipal.`,
    instructions: [
      '1. Acessar portal Vigilancia Sanitaria do municipio',
      '2. Solicitar renovacao com 60 dias de antecedencia',
      '3. Anexar documentos (contrato social, CRO, CNES, PCMSO/PGR, IPTU)',
      '4. Pagar taxa e aguardar inspecao',
      '5. Cadastrar nova data quando receber novo alvara',
    ],
    help_url: 'https://www.gov.br/anvisa/pt-br', // generico - cada municipio tem o seu
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
    help_url: null, // varia por municipio
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
  das_sn_darf,
  pgdas_d,
  das_mei,
  sngpc_inventario,
  cro_anuidade,
  alvara_vigilancia,
  pcmso,
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
