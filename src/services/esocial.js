// ============================================================
// AURA. — Gerador de XMLs eSocial S-1.3
// Feature: BE-29b
// ============================================================
// Gera os arquivos XML nos eventos principais do eSocial
// para ME com 2+ funcionários, layout S-1.3 (vigente desde dez/2024).
//
// Eventos implementados:
//   S-2200 — Admissão de funcionário
//   S-1200 — Remuneração mensal
//   S-1299 — Fechamento da folha (aciona FGTS Digital)
//
// O XML gerado está pronto para assinar com e-CNPJ A1.
// BE-29c (transmissão automática) usará estes geradores.
//
// Referência: leiaute S-1.3 oficial
// https://www.gov.br/esocial/pt-br/documentacao-tecnica
// ============================================================

const { v4: uuidv4 } = require('uuid');

// ─── Helpers ─────────────────────────────────────────────────

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// Formata data Date → YYYY-MM-DD
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Formata número com 2 casas decimais (padrão eSocial)
function fmtNum(n) {
  return parseFloat(n || 0).toFixed(2);
}

// Remove caracteres não numéricos de CNPJ/CPF
function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Gera ID único do evento no formato [ID|nrRec|versao]
// Antes da transmissão, usa formato local: ID + timestamp
function gerarIdEvento(prefixo) {
  const ts  = Date.now().toString();
  const uid = uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  return `ID${prefixo}${ts}${uid}`;
}

// Escapa caracteres especiais XML
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Header padrão de todos os eventos eSocial S-1.3
function headerEvento(nrRec, companyId, cnpj, transmissorCnpj) {
  const now = new Date();
  const dhGer = `${fmtDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `
  <ideEvento>
    <indRetif>1</indRetif>
    <nrRec>${esc(nrRec)}</nrRec>
    <dhGer>${dhGer}</dhGer>
    <indGuia>1</indGuia>
    <tpAmb>2</tpAmb>
    <procEmi>1</procEmi>
    <verProc>1.0.0</verProc>
  </ideEvento>
  <ideEmpregador>
    <tpInsc>1</tpInsc>
    <nrInsc>${esc(onlyDigits(cnpj).substring(0, 8))}</nrInsc>
  </ideEmpregador>
  <ideTransmissor>
    <tpInsc>1</tpInsc>
    <nrInsc>${esc(onlyDigits(transmissorCnpj || cnpj))}</nrInsc>
  </ideTransmissor>`;
}

// ─── S-2200 — Admissão de Funcionário ────────────────────────
// Referência: eSocial S-1.3 / leiaute evtAdmissao
//
// @param employee  { id, name, cpf, admission_date, base_salary, role,
//                    work_hours, contract_type, pis, birth_date,
//                    nationality, scholarity, cbo }
// @param company   { cnpj, razao_social, cod_lotacao }

function gerarS2200(employee, company) {
  const nrRec = gerarIdEvento('S2200');
  const cnpj  = onlyDigits(company.cnpj);
  const cpf   = onlyDigits(employee.cpf);

  // Defaults razoáveis para campos opcionais
  const cbo        = employee.cbo        || '412405'; // Assistente administrativo
  const codLotacao = company.cod_lotacao || '001';
  const natAtividade = employee.nat_atividade || '01'; // 01=normal
  const tpContr    = employee.contract_type  || '1';   // 1=prazo indeterminado
  const dtAdm      = fmtDate(employee.admission_date);
  const tpRegTrab  = '1'; // 1=CLT
  const tpRegPrev  = '1'; // 1=RGPS
  const duracao    = employee.work_hours  || 44;       // horas semanais
  const dtNasc     = fmtDate(employee.birth_date);
  const codMun     = employee.cod_municipio || '350650'; // Jacareí/SP
  const uf         = employee.state         || 'SP';
  const grauInstr  = employee.scholarity    || '07';   // ensino médio completo
  const nmSoc      = employee.social_name   || '';
  const sexo       = employee.gender        || 'M';
  const racaCor    = employee.race          || '7';    // não informado
  const estCiv     = employee.marital       || '9';    // não informado
  const indPriEmpr = employee.first_job     ? 'S' : 'N';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtAdmissao/v_S_01_03_00"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.esocial.gov.br/schema/evt/evtAdmissao/v_S_01_03_00 evtAdmissao_v_S_01_03_00.xsd">
  <evtAdmissao Id="${nrRec}">
    ${headerEvento(nrRec, company.id, cnpj, cnpj)}
    <vinculo>
      <cpfTrab>${cpf}</cpfTrab>
      <nisTrab>${esc(employee.pis || '')}</nisTrab>
      <infoContrato>
        <nmTrab>${esc(employee.name)}</nmTrab>
        <sexo>${sexo}</sexo>
        <racaCor>${racaCor}</racaCor>
        <estCiv>${estCiv}</estCiv>
        <grauInstr>${grauInstr}</grauInstr>
        ${dtNasc ? `<nascimento><dtNasc>${dtNasc}</dtNasc><codMunic>${codMun}</codMunic><uf>${uf}</uf></nascimento>` : ''}
        ${nmSoc ? `<nmSoc>${esc(nmSoc)}</nmSoc>` : ''}
        <indPriEmpr>${indPriEmpr}</indPriEmpr>
        <admissao>
          <dtAdm>${dtAdm}</dtAdm>
          <tpAdmissao>1</tpAdmissao>
          <indAdmissao>1</indAdmissao>
          <nrProcTrab></nrProcTrab>
          <natAtividade>${natAtividade}</natAtividade>
        </admissao>
        <vinculo>
          <tpRegTrab>${tpRegTrab}</tpRegTrab>
          <tpRegPrev>${tpRegPrev}</tpRegPrev>
          <dtIniCond></dtIniCond>
        </vinculo>
        <infoRegimeTrab>
          <infoCeletista>
            <dtBase>01</dtBase>
            <cnpjSindCateg></cnpjSindCateg>
            <trabIntermitente>
              <indContJornMei>N</indContJornMei>
            </trabIntermitente>
          </infoCeletista>
        </infoRegimeTrab>
        <infoContrato>
          <codCateg>101</codCateg>
          <dtAdm>${dtAdm}</dtAdm>
          <tpContr>${tpContr}</tpContr>
          <remuneracao>
            <vrSalFx>${fmtNum(employee.base_salary)}</vrSalFx>
            <undSalFixo>5</undSalFixo>
          </remuneracao>
          <duracao>
            <tpContr>${tpContr}</tpContr>
          </duracao>
          <localTrabalho>
            <localTrabGeral>
              <tpInsc>1</tpInsc>
              <nrInsc>${cnpj}</nrInsc>
              <descComp>${esc(company.razao_social || 'Estabelecimento principal')}</descComp>
            </localTrabGeral>
          </localTrabalho>
          <horContratual>
            <qtdHrsSem>${duracao}</qtdHrsSem>
            <tpJornada>2</tpJornada>
            <tmpParc>0</tmpParc>
            <horarioTrab>
              <codHorContrat>001</codHorContrat>
            </horarioTrab>
          </horContratual>
          <filiacaoSindical>
            <cnpjSindTrab></cnpjSindTrab>
          </filiacaoSindical>
          <infoSubstituto>
            <origCargo>0</origCargo>
          </infoSubstituto>
        </infoContrato>
        <infoCompl>
          <desCargo>${esc(employee.role || 'Funcionário')}</desCargo>
          <cbo>${cbo}</cbo>
          <codLotacao>${esc(codLotacao)}</codLotacao>
        </infoCompl>
      </infoContrato>
    </vinculo>
  </evtAdmissao>
  <Signature/>
</eSocial>`;

  return { xml, nrRec, evento: 'S-2200', employee_id: employee.id };
}

// ─── S-1200 — Remuneração Mensal ────────────────────────────
// Referência: eSocial S-1.3 / leiaute evtRemun
//
// @param payrollRecords  Array de { employee_id, cpf, pis, name,
//                          gross_salary, inss_employee, irrf, fgts,
//                          net_salary, other_deductions }
// @param period    'YYYY-MM'
// @param company   { cnpj, cod_lotacao }

function gerarS1200(payrollRecords, period, company) {
  const nrRec = gerarIdEvento('S1200');
  const cnpj  = onlyDigits(company.cnpj);
  const [year, month] = period.split('-');
  const perApur = `${year}-${month}`;
  const codLotacao = company.cod_lotacao || '001';

  const remuns = payrollRecords.map(pr => {
    const cpf = onlyDigits(pr.cpf);
    return `
      <dmDev>
        <ideDmDev>DM${onlyDigits(period)}${cpf.substring(0, 6)}</ideDmDev>
        <codCateg>101</codCateg>
        <infoPerApur>
          <ideEstabLot>
            <tpInsc>1</tpInsc>
            <nrInsc>${cnpj}</nrInsc>
            <codLotacao>${esc(codLotacao)}</codLotacao>
            <detVerbas>
              <!-- Salário base -->
              <idRubr>0001</idRubr>
              <qtdRubr>1.00</qtdRubr>
              <fatorRubr>1.00</fatorRubr>
              <vrRubr>${fmtNum(pr.gross_salary)}</vrRubr>
            </detVerbas>
            ${parseFloat(pr.other_deductions || 0) > 0 ? `
            <detVerbas>
              <!-- Outros descontos -->
              <idRubr>9999</idRubr>
              <qtdRubr>1.00</qtdRubr>
              <fatorRubr>1.00</fatorRubr>
              <vrRubr>${fmtNum(pr.other_deductions)}</vrRubr>
            </detVerbas>` : ''}
          </ideEstabLot>
          <infoSaudeColet>
            <plano>
              <tpPlano>0</tpPlano>
            </plano>
          </infoSaudeColet>
        </infoPerApur>
        <infoComplCont>
          <codOcorr>05</codOcorr>
        </infoComplCont>
      </dmDev>`;
  }).join('');

  const ideTrabs = payrollRecords.map(pr => {
    const cpf = onlyDigits(pr.cpf);
    return `
    <ideTrabalhador>
      <cpfTrab>${cpf}</cpfTrab>
      <nisTrab>${esc(pr.pis || '')}</nisTrab>
      ${remuns}
    </ideTrabalhador>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtRemun/v_S_01_03_00"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.esocial.gov.br/schema/evt/evtRemun/v_S_01_03_00 evtRemun_v_S_01_03_00.xsd">
  <evtRemun Id="${nrRec}">
    ${headerEvento(nrRec, company.id, cnpj, cnpj)}
    <ideEvento>
      <indRetif>1</indRetif>
      <nrRec>${nrRec}</nrRec>
      <indApuracao>1</indApuracao>
      <perApur>${perApur}</perApur>
      <indGuia>1</indGuia>
    </ideEvento>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj.substring(0, 8)}</nrInsc>
    </ideEmpregador>
    ${ideTrabs}
  </evtRemun>
  <Signature/>
</eSocial>`;

  return { xml, nrRec, evento: 'S-1200', period, total_funcionarios: payrollRecords.length };
}

// ─── S-1299 — Fechamento da Folha ────────────────────────────
// Referência: eSocial S-1.3 / leiaute evtFechaEvPer
// Deve ser enviado APÓS o S-1200. Sem ele, o FGTS Digital não é gerado.
//
// @param period    'YYYY-MM'
// @param company   { cnpj }
// @param totais    { total_salarios, total_inss_empresa, total_fgts }

function gerarS1299(period, company, totais = {}) {
  const nrRec = gerarIdEvento('S1299');
  const cnpj  = onlyDigits(company.cnpj);
  const [year, month] = period.split('-');
  const perApur = `${year}-${month}`;

  const vrCpSeg    = fmtNum(totais.total_inss_empresa || 0);
  const vrFgts     = fmtNum(totais.total_fgts        || 0);
  const vrSalarios = fmtNum(totais.total_salarios     || 0);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtFechaEvPer/v_S_01_03_00"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.esocial.gov.br/schema/evt/evtFechaEvPer/v_S_01_03_00 evtFechaEvPer_v_S_01_03_00.xsd">
  <evtFechaEvPer Id="${nrRec}">
    ${headerEvento(nrRec, company.id, cnpj, cnpj)}
    <ideEvento>
      <indRetif>1</indRetif>
      <nrRec>${nrRec}</nrRec>
      <indApuracao>1</indApuracao>
      <perApur>${perApur}</perApur>
    </ideEvento>
    <ideEmpregador>
      <tpInsc>1</tpInsc>
      <nrInsc>${cnpj.substring(0, 8)}</nrInsc>
    </ideEmpregador>
    <infoFech>
      <evtRemun>S</evtRemun>
      <evtPgtos>N</evtPgtos>
      <evtAqProd>N</evtAqProd>
      <evtComProd>N</evtComProd>
      <evtContratAvNP>N</evtContratAvNP>
      <evtInfoComplPer>N</evtInfoComplPer>
      <vrCpSeg>${vrCpSeg}</vrCpSeg>
      <vrDescCP>${vrSalarios}</vrDescCP>
      <!-- vrFgts gerado automaticamente pelo eSocial a partir dos S-1200 enviados -->
    </infoFech>
    <infoAdicAFRFB/>
  </evtFechaEvPer>
  <Signature/>
</eSocial>`;

  return { xml, nrRec, evento: 'S-1299', period, totais };
}

// ─── S-2299 — Desligamento ───────────────────────────────────
// Referência: eSocial S-1.3 / leiaute evtDeslig
//
// @param employee   { id, cpf, pis, name, admission_date }
// @param termination { dt_deslig, mot_deslig, ind_comunicado, dt_aviso_prev }
//   mot_deslig: '01'=sem justa causa, '03'=pedido demissão, '05'=culpa recíproca...
// @param company   { cnpj }

function gerarS2299(employee, termination, company) {
  const nrRec  = gerarIdEvento('S2299');
  const cnpj   = onlyDigits(company.cnpj);
  const cpf    = onlyDigits(employee.cpf);
  const dtDeslig = fmtDate(termination.dt_deslig);
  const motDeslig = termination.mot_deslig || '01'; // padrão: dispensa sem justa causa

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtDeslig/v_S_01_03_00"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.esocial.gov.br/schema/evt/evtDeslig/v_S_01_03_00 evtDeslig_v_S_01_03_00.xsd">
  <evtDeslig Id="${nrRec}">
    ${headerEvento(nrRec, company.id, cnpj, cnpj)}
    <ideVinculo>
      <cpfTrab>${cpf}</cpfTrab>
      <nisTrab>${esc(employee.pis || '')}</nisTrab>
      <dtAdm>${fmtDate(employee.admission_date)}</dtAdm>
    </ideVinculo>
    <infoDeslig>
      <dtDeslig>${dtDeslig}</dtDeslig>
      <mtvDeslig>${motDeslig}</mtvDeslig>
      <dtAvAnt>${termination.dt_aviso_prev ? fmtDate(termination.dt_aviso_prev) : ''}</dtAvAnt>
      <indDesabResp>0</indDesabResp>
      <indCumprAv>${termination.ind_cumpr_av || '1'}</indCumprAv>
      <indCompl>N</indCompl>
      <infoPensFoodAlim/>
      <verbasResc>
        <dtPagto>${termination.dt_pagto ? fmtDate(termination.dt_pagto) : dtDeslig}</dtPagto>
        <nrProcTrab></nrProcTrab>
      </verbasResc>
    </infoDeslig>
  </evtDeslig>
  <Signature/>
</eSocial>`;

  return { xml, nrRec, evento: 'S-2299', employee_id: employee.id };
}

module.exports = {
  gerarS2200,
  gerarS1200,
  gerarS1299,
  gerarS2299,
  // utilitários
  fmtDate,
  fmtNum,
  onlyDigits,
};
