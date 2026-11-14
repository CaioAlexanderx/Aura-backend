// ============================================================
// AURA. — NF-e modelo 55 de VENDA: dados da nota a partir da venda.
// 14/11/2026 — CP2b. Usado por routes/nfe55Venda.js (prévia e emissão).
//
// A venda gravada é a fonte da verdade (mesma regra da NFC-e,
// services/descontoDaVendaNaNfce.js): os itens saem de sale_items, o
// desconto da venda (cupom + manual) é rateado no vDesc de cada linha, a
// linha "Frete" sai da lista de produtos e vira vFrete rateado nos itens,
// serviço (products.unit 'srv' / nota_fiscal 'nfse') fica fora (vai na
// NFS-e) e os pagamentos da venda entram na proporção do total da nota.
//
// Destinatário: pré-preenchido do cadastro do cliente da venda; o que vier
// no corpo vence. Código IBGE do município pelo CEP (services/ibgePeloCep,
// ViaCEP) quando o cadastro não tem. Faltou dado obrigatório → lista de
// faltantes em linguagem humana (o wizard do app marca em amarelo).
//
// Regras do v1 (decisões de 14/11):
//   • só Simples Nacional e MEI (regime normal: recusa gentil);
//   • UF do emitente: SP; AP/RJ abrem com NFE55_VENDA_UFS=SP,AP,RJ;
//   • DIFAL (outra UF + não contribuinte) fora: recusa gentil;
//   • CFOP pelo destino: 5102/5405 na UF, 6102/6404 fora (taxEngine);
//   • uma nota de PRODUTOS por venda (NFC-e ou NF-e, nos dois sentidos).
//
// Multi-CNPJ: a venda tem que ser da loja que emite (sales.company_id); o
// cliente é do dono (owner-scope, routes/customers.js) e é lido pelo id que
// a venda aponta; produto compartilhado do grupo acha o NCM pela regra de
// visibilidade (utils/companyGroup.js), como no /nfce/emit.
// ============================================================
'use strict';

const taxEngine = require('./sefazSp/taxEngine');
const { ENDPOINTS_NFE55 } = require('./sefazSp/nfe55');
const { ufToCodigo } = require('./sefazSp/nfeHelpers');
const { productVisibilityWhere } = require('../utils/companyGroup');
const { isValidCpf, isValidCnpj } = require('../utils/cpfCnpj');
const {
  ehUuid, ehFrete, centavos, linhasDaVendaGravada, aplicarDescontoNasLinhas, MENSAGEM_DESCONTO_TOTAL,
} = require('./descontoDaVendaNaNfce');
const { separarServicos, pagamentosDosProdutos } = require('./nfceSemServico');
const { ibgePeloCep } = require('./ibgePeloCep');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}
/** Corpo vence quando trouxe valor; senão, o cadastro. */
function vence(doCorpo, doCadastro) {
  const c = texto(doCorpo);
  return c !== null ? c : texto(doCadastro);
}

// ── Mensagens ───────────────────────────────────────────────

const MSG = {
  vendaNaoEncontrada: 'Não encontramos esta venda nesta loja.',
  vendaCancelada: 'Esta venda foi cancelada, então não dá para emitir nota fiscal para ela.',
  vendaTroca: 'Esta venda é de uma troca. A nota da troca sai pelo próprio fluxo da troca.',
  naoConfigurada: 'A emissão de nota fiscal ainda não está configurada. Acesse Configurações > Nota Fiscal.',
  regimeNormal: 'Ainda não emitimos NF-e para empresas do regime normal (Lucro Presumido ou Lucro Real). '
    + 'Por enquanto a NF-e de venda pela Aura é para o Simples Nacional e o MEI. Se precisar, fale com o suporte.',
  difal: 'Venda para consumidor final de outro estado que não tem inscrição estadual tem uma conta a mais de imposto '
    + '(o DIFAL), e essa NF-e a Aura ainda não emite. Você pode emitir uma NFC-e no balcão ou falar com o seu contador.',
  exterior: 'Ainda não emitimos NF-e para clientes de fora do Brasil.',
  semProdutos: 'Esta venda só tem serviços. A NF-e é nota de mercadoria; o serviço sai na nota de serviço (NFS-e).',
  numeracao: 'A numeração da NF-e ainda não está pronta nesta loja. Fale com o suporte.',
};

function ufsHabilitadas() {
  const raw = process.env.NFE55_VENDA_UFS;
  const lista = String(raw || 'SP').split(/[,\s;]+/).map((u) => u.trim().toUpperCase()).filter(Boolean);
  return lista.filter((u) => !!ENDPOINTS_NFE55[u]);
}

function mensagemUfNaoHabilitada(uf) {
  return `A NF-e de venda pela Aura ainda não está liberada para lojas de ${uf}. `
    + 'Por enquanto, emita NFC-e ou fale com o suporte.';
}

// ── IE ──────────────────────────────────────────────────────

/** IE de SP (12 dígitos, comércio): dois dígitos verificadores. */
function ieSpValida(ie) {
  const d = onlyDigits(ie);
  if (d.length !== 12) return false;
  const n = d.split('').map(Number);
  const p1 = [1, 3, 4, 5, 6, 7, 8, 10];
  const s1 = p1.reduce((s, p, i) => s + p * n[i], 0);
  if ((s1 % 11) % 10 !== n[8]) return false;
  const p2 = [3, 2, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const s2 = p2.reduce((s, p, i) => s + p * n[i], 0);
  return (s2 % 11) % 10 === n[11];
}

/** Formato do XSD (2 a 14 dígitos) + DV quando a UF é SP. */
function ieValida(ie, uf) {
  const d = onlyDigits(ie);
  if (d.length < 2 || d.length > 14) return false;
  if (String(uf || '').toUpperCase() === 'SP') return ieSpValida(d);
  return true;
}

// ── Leitura (defensiva: colunas novas da migration 450) ─────

let temColunasNfe55Cliente = true; // false = 42703 visto (migration 450 ausente)
function _resetCaches() { temColunasNfe55Cliente = true; }

const COLS_CLIENTE = 'id, name, cpf_cnpj, email, phone, street, number, address_number, complement, '
  + 'neighborhood, city, state, zip_code, postal_code';
const COLS_CLIENTE_450 = ', ie, ind_ie_dest, codigo_municipio_ibge';

/** Lojas do mesmo dono (o cliente é do dono — mesma regra de utils/ownerScope). */
async function lojasDoDono(db, companyId) {
  const { rows } = await db.query(
    `SELECT id FROM companies
      WHERE owner_id = (SELECT owner_id FROM companies WHERE id = $1)
        AND is_active = true`,
    [companyId]
  );
  const ids = rows.map((r) => r.id);
  if (!ids.includes(companyId)) ids.push(companyId);
  return ids;
}

async function lerCliente(db, companyId, customerId) {
  if (!ehUuid(String(customerId || ''))) return null;
  const donos = await lojasDoDono(db, companyId);
  const sql = (cols) => `SELECT ${cols} FROM customers WHERE id = $1 AND company_id = ANY($2)`;
  if (temColunasNfe55Cliente) {
    try {
      const { rows } = await db.query(sql(COLS_CLIENTE + COLS_CLIENTE_450), [customerId, donos]);
      return rows[0] || null;
    } catch (e) {
      if (e.code !== '42703') throw e;
      temColunasNfe55Cliente = false;
    }
  }
  const { rows } = await db.query(sql(COLS_CLIENTE), [customerId, donos]);
  return rows[0] || null;
}

async function lerVenda(db, companyId, saleId) {
  if (!ehUuid(String(saleId || ''))) return null;
  const { rows } = await db.query(
    `SELECT * FROM sales WHERE id = $1 AND company_id = $2`,
    [saleId, companyId]
  );
  return rows[0] || null;
}

async function lerItensDaVenda(db, saleId) {
  const { rows } = await db.query(
    `SELECT product_id, variant_id, quantity, unit_price, discount, total_price, product_name_snapshot
       FROM sale_items WHERE sale_id = $1 ORDER BY id`,
    [saleId]
  );
  return rows;
}

async function lerPagamentosDaVenda(db, saleId) {
  try {
    const { rows } = await db.query(
      `SELECT method, amount FROM sale_payments WHERE sale_id = $1 ORDER BY created_at, id`,
      [saleId]
    );
    return rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return [];
    throw e;
  }
}

async function lerEmpresa(db, companyId) {
  const { rows } = await db.query(
    `SELECT id, cnpj, legal_name, trade_name,
            address_street, address_number, address_district AS address_neighborhood,
            address_city, address_state, address_zip,
            inscricao_estadual, inscricao_municipal, ibge_code, email, phone, tax_regime
       FROM companies WHERE id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

async function lerConfig(db, companyId) {
  const { rows } = await db.query('SELECT * FROM nfce_config WHERE company_id = $1', [companyId]);
  return rows[0] || null;
}

/** Motivo do certificado A1 não servir (null = vigente). */
async function motivoCertificado(db, companyId) {
  try {
    const { rows } = await db.query(
      'SELECT not_after FROM company_certificates WHERE company_id = $1 ORDER BY not_after DESC LIMIT 1',
      [companyId]
    );
    if (!rows.length) {
      return 'Certificado digital (A1) não enviado. Envie o certificado em Configurações > Nota Fiscal para emitir.';
    }
    if (new Date(rows[0].not_after).getTime() <= Date.now()) {
      const venceu = new Date(rows[0].not_after).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `O certificado digital (A1) da empresa venceu em ${venceu}. Envie o novo certificado em Configurações > Nota Fiscal para voltar a emitir.`;
    }
    return null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    return 'Emissão de nota fiscal indisponível para esta empresa. Fale com o suporte.';
  }
}

async function lerProdutos(db, companyId, productIds) {
  const map = new Map();
  if (!productIds.length) return map;
  const sql = (extra) => `SELECT id, ncm, tax_profile, unit, barcode${extra} FROM products
      WHERE id = ANY($1::uuid[]) AND ${productVisibilityWhere('$2')}`;
  const tentativas = [', nota_fiscal, cest, origem, icms_st_paid', ', cest, origem, icms_st_paid', ''];
  let rows = null;
  for (const extra of tentativas) {
    try {
      ({ rows } = await db.query(sql(extra), [productIds, companyId]));
      break;
    } catch (e) {
      if (e.code !== '42703') throw e;
    }
  }
  for (const p of rows || []) map.set(p.id, p);
  return map;
}

// ── Duplicidade (uma nota de produtos por venda) ───────────

// Status que dizem "a venda JÁ TEM nota de produtos" (ou pode ter: a
// processando pode estar autorizada na SEFAZ). Cancelada, rejeitada e erro
// não contam.
const STATUS_QUE_TRAVAM = ['autorizada', 'processando', 'contingencia', 'denegada'];

let temColunaFinalidade = true;

/**
 * Notas de PRODUTOS da venda (NFC-e e NF-e de venda — a 55 de devolução,
 * finalidade 4, fica fora). Todas, da mais recente para a mais antiga,
 * qualquer status, para quem chama decidir.
 */
async function notasDaVenda(db, companyId, saleId) {
  if (!ehUuid(String(saleId || ''))) return [];
  const run = (comFinalidade) => db.query(
    `SELECT * FROM nfce_emissions
      WHERE company_id = $1 AND sale_id = $2
        AND (tipo = 'nfce' OR (tipo = 'nfe'${comFinalidade ? ' AND COALESCE(finalidade, 1) <> 4' : ''}))
      ORDER BY created_at DESC`,
    [companyId, saleId]
  );
  let rows;
  if (temColunaFinalidade) {
    try { ({ rows } = await run(true)); } catch (e) {
      if (e.code !== '42703') throw e;
      temColunaFinalidade = false;
    }
  }
  if (!rows) ({ rows } = await run(false));
  return rows;
}

/** NF-e de venda que trava a NFC-e (usada pelo /nfce/emit). */
async function nfeDeVendaQueTrava(db, companyId, saleId) {
  if (!ehUuid(String(saleId || ''))) return null;
  const rows = await notasDaVenda(db, companyId, saleId);
  return rows.find((r) => r.tipo === 'nfe' && ['autorizada', 'processando', 'denegada'].includes(r.status)) || null;
}

// ── Destinatário ────────────────────────────────────────────

/**
 * Junta cadastro + corpo e confere. buscarIbge é injetável (testes).
 * @returns {{ dest, faltantes[], origem }}
 */
async function resolverDestinatario({ cliente, doCorpo, buscarIbge, ufEmitente }) {
  const b = doCorpo || {};
  const be = b.endereco || {};
  const c = cliente || {};
  const faltantes = [];
  const falta = (campo, mensagem, tipo = 'faltando') => faltantes.push({ campo, mensagem, tipo });

  const documento = onlyDigits(vence(b.documento, c.cpf_cnpj));
  const nome = vence(b.nome, c.name);
  const email = vence(b.email, c.email);
  const fone = vence(b.telefone, c.phone);
  const cepCadastro = onlyDigits(c.zip_code || c.postal_code);
  const cepCorpo = onlyDigits(be.cep);
  const cep = cepCorpo || cepCadastro;
  const endereco = {
    cep,
    logradouro: vence(be.logradouro, c.street),
    numero: vence(be.numero, c.number || c.address_number),
    complemento: vence(be.complemento, c.complement),
    bairro: vence(be.bairro, c.neighborhood),
    municipio: vence(be.municipio, c.city),
    uf: (vence(be.uf, c.state) || '').toUpperCase() || null,
    codigo_municipio_ibge: null,
    fone,
  };
  // IBGE: corpo > cadastro (só se o CEP não mudou) > ViaCEP pelo CEP.
  const ibgeCorpo = onlyDigits(be.codigo_municipio_ibge);
  const ibgeCadastro = (!cepCorpo || cepCorpo === cepCadastro) ? onlyDigits(c.codigo_municipio_ibge) : '';
  let ibge = ibgeCorpo || ibgeCadastro || null;
  let viaCep = null;
  if (cep.length === 8 && (!ibge || !endereco.municipio || !endereco.uf || !endereco.bairro || !endereco.logradouro)) {
    viaCep = await buscarIbge(cep);
    if (viaCep) {
      if (!ibge) ibge = viaCep.ibge;
      if (!endereco.municipio) endereco.municipio = viaCep.municipio;
      if (!endereco.uf) endereco.uf = viaCep.uf;
      if (!endereco.bairro && viaCep.bairro) endereco.bairro = viaCep.bairro;
      if (!endereco.logradouro && viaCep.logradouro) endereco.logradouro = viaCep.logradouro;
    }
  }
  endereco.codigo_municipio_ibge = ibge;

  // Documento
  if (!documento) {
    falta('destinatario.documento', 'CPF ou CNPJ do cliente');
  } else if (documento.length === 11 ? !isValidCpf(documento) : documento.length === 14 ? !isValidCnpj(documento) : true) {
    falta('destinatario.documento', 'O CPF ou CNPJ do cliente não confere. Confira os números com o cliente.', 'invalido');
  }
  if (!nome || nome.length < 2) falta('destinatario.nome', 'Nome ou razão social do cliente');

  // Endereço
  if (!endereco.logradouro || endereco.logradouro.length < 2) falta('destinatario.endereco.logradouro', 'Rua (logradouro) do endereço do cliente');
  if (!endereco.bairro || endereco.bairro.length < 2) falta('destinatario.endereco.bairro', 'Bairro do endereço do cliente');
  if (!cep) falta('destinatario.endereco.cep', 'CEP do endereço do cliente');
  else if (cep.length !== 8) falta('destinatario.endereco.cep', 'O CEP do cliente precisa ter 8 números.', 'invalido');
  if (!endereco.uf) {
    falta('destinatario.endereco.uf', 'Estado (UF) do endereço do cliente');
  } else {
    let codUf = null;
    try { codUf = endereco.uf === 'EX' ? null : ufToCodigo(endereco.uf); } catch (_) { codUf = null; }
    if (endereco.uf !== 'EX' && !codUf) {
      falta('destinatario.endereco.uf', `O estado "${endereco.uf}" não existe. Use a sigla (ex.: SP, MG).`, 'invalido');
    } else if (viaCep && viaCep.uf && viaCep.uf !== endereco.uf) {
      falta('destinatario.endereco.cep', `O CEP ${cep} é de ${viaCep.uf}, mas o endereço diz ${endereco.uf}. Confira o CEP ou o estado.`, 'invalido');
    } else if (ibge && codUf && (ibge.length !== 7 || Number(ibge.slice(0, 2)) !== codUf)) {
      falta('destinatario.endereco.codigo_municipio_ibge', 'O código do município não é do estado informado. Confira a cidade.', 'invalido');
    }
  }
  if (!endereco.municipio) falta('destinatario.endereco.municipio', 'Cidade do endereço do cliente');
  if (!ibge) {
    falta('destinatario.endereco.codigo_municipio_ibge',
      'Não conseguimos achar o município pelo CEP. Confira o CEP ou informe a cidade (código IBGE de 7 números).');
  } else if (ibge.length !== 7 && !faltantes.some((f) => f.campo === 'destinatario.endereco.codigo_municipio_ibge')) {
    falta('destinatario.endereco.codigo_municipio_ibge', 'O código IBGE do município tem 7 números.', 'invalido');
  }

  // IE / indIEDest
  const ieRaw = vence(b.ie, c.ie);
  const ieIsento = String(ieRaw || '').trim().toUpperCase() === 'ISENTO';
  const ie = ieIsento ? null : (onlyDigits(ieRaw) || null);
  const indRaw = b.ind_ie_dest !== undefined && b.ind_ie_dest !== null && b.ind_ie_dest !== ''
    ? b.ind_ie_dest : c.ind_ie_dest;
  let indIEDest = indRaw !== undefined && indRaw !== null && indRaw !== '' ? String(Number(indRaw)) : null;
  if (indIEDest && !['1', '2', '9'].includes(indIEDest)) {
    falta('destinatario.ind_ie_dest', 'Indicador da IE inválido. Use 1 (contribuinte), 2 (isento) ou 9 (não contribuinte).', 'invalido');
    indIEDest = null;
  }
  if (!indIEDest) indIEDest = ieIsento ? '2' : (ie ? '1' : '9');
  if (indIEDest === '1') {
    if (!ie) falta('destinatario.ie', 'Inscrição estadual (IE) do cliente contribuinte');
    else if (!ieValida(ie, endereco.uf)) {
      falta('destinatario.ie', 'A inscrição estadual (IE) do cliente não confere. Confira o número com o cliente.', 'invalido');
    }
  }

  const dest = {
    documento, cpf: documento.length === 11 ? documento : null, cnpj: documento.length === 14 ? documento : null,
    nome, email, ie: indIEDest === '1' ? ie : null, indIEDest,
    endereco,
  };
  const origem = { cadastro: !!cliente, ibge: ibgeCorpo ? 'corpo' : ibgeCadastro ? 'cadastro' : (viaCep ? 'viacep' : null) };
  return { dest, faltantes, origem, ufEmitente };
}

// ── Itens ───────────────────────────────────────────────────

/** Frete (centavos) proporcional às bases, maior resto; sem teto por linha. */
function ratearFrete(bases, freteC) {
  const soma = bases.reduce((s, b) => s + b, 0);
  if (!(freteC > 0) || soma <= 0) return bases.map(() => 0);
  const base = bases.map((b) => Math.floor((b * freteC) / soma));
  let resto = freteC - base.reduce((s, v) => s + v, 0);
  const ordem = bases.map((b, i) => ({ i, frac: (b * freteC) / soma - base[i] }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; resto > 0 && k < ordem.length; k++, resto--) base[ordem[k].i] += 1;
  return base;
}

function validNcm(n) {
  const s = onlyDigits(n);
  return (s.length === 8 && s !== '00000000') ? s : null;
}

const TPAG = {
  dinheiro: '01', cheque: '02', credito: '03', cartao: '03', cartao_credito: '03',
  debito: '04', cartao_debito: '04', crediario: '05', fiado: '05', credito_troca: '05',
  boleto: '15', pix: '17', outros: '99',
};
const A_PRAZO = new Set(['crediario', 'fiado']);

function pagamentoDaNota(method, value) {
  const m = String(method || '').toLowerCase();
  return { method: TPAG[m] || '99', value, indPag: A_PRAZO.has(m) ? 1 : 0, forma: m || 'outros' };
}

/**
 * Monta tudo o que a nota precisa a partir da venda.
 * @returns {{ bloqueio?: {status, code, error}, faltantes, company, config,
 *            venda, cliente, nfeData, previa }}
 */
async function montarNotaDaVenda(db, { companyId, saleId, body, buscarIbge = ibgePeloCep }) {
  const b = body || {};
  const bloqueio = (status, code, error, extra) => ({ bloqueio: { status, code, error, ...(extra || {}) } });

  const venda = await lerVenda(db, companyId, saleId);
  if (!venda) return bloqueio(404, 'VENDA_NAO_ENCONTRADA', MSG.vendaNaoEncontrada);
  if (venda.status === 'cancelled') return bloqueio(422, 'VENDA_CANCELADA', MSG.vendaCancelada);
  if (venda.type === 'troca') return bloqueio(422, 'VENDA_DE_TROCA', MSG.vendaTroca);

  const config = await lerConfig(db, companyId);
  if (!config || !config.is_active) return bloqueio(422, 'NFE_NAO_CONFIGURADA', MSG.naoConfigurada);

  const company = await lerEmpresa(db, companyId);
  if (!company) return bloqueio(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada.');
  if (!company.cnpj) {
    return bloqueio(422, 'CNPJ_REQUIRED', 'Para emitir nota fiscal a empresa precisa de CNPJ.');
  }
  if (!company.inscricao_estadual && config.inscricao_estadual) company.inscricao_estadual = config.inscricao_estadual;
  if (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') {
    return bloqueio(422, 'NFE_REGIME_NORMAL_FORA_DO_V1', MSG.regimeNormal);
  }
  const ufCfg = String(config.uf || '').toUpperCase().trim();
  const ufEnd = String(company.address_state || '').toUpperCase().trim();
  if (ufCfg && ufEnd && ufCfg !== ufEnd) {
    return bloqueio(422, 'NFE_UF_DIVERGENTE', `A UF da configuração da nota (${ufCfg}) é diferente da UF do endereço da empresa (${ufEnd}). Ajuste uma das duas antes de emitir.`);
  }
  if (!ufEnd) company.address_state = ufCfg || 'SP';
  const ufEmitente = String(company.address_state).toUpperCase();
  if (!ufsHabilitadas().includes(ufEmitente)) {
    return bloqueio(422, 'NFE55_UF_NAO_HABILITADA', mensagemUfNaoHabilitada(ufEmitente));
  }
  const faltaEmitente = [];
  if (!company.ibge_code) faltaEmitente.push('o código IBGE do município da empresa');
  if (!company.inscricao_estadual) faltaEmitente.push('a inscrição estadual (IE) da empresa');
  if (faltaEmitente.length) {
    return bloqueio(422, 'NFE_EMITENTE_INCOMPLETO',
      `Falta ${faltaEmitente.join(' e ')}. Complete em Configurações > Empresa e tente de novo.`);
  }
  const crt = company.tax_regime === 'mei' ? 4 : 1;

  // Itens da venda gravada + desconto rateado (mesmo rateio da NFC-e).
  const saleItems = await lerItensDaVenda(db, saleId);
  if (!saleItems.length) return bloqueio(422, 'NFE_SEM_PRODUTOS', 'Esta venda não tem itens para a nota.');
  const rateio = aplicarDescontoNasLinhas(linhasDaVendaGravada(saleItems), Number(venda.discount_amount) || 0);
  if (rateio.erro) return bloqueio(422, 'NFE_DESCONTO_TOTAL', MENSAGEM_DESCONTO_TOTAL);

  // Frete sai da lista de produtos (vira vFrete); serviço sai da nota.
  const linhasFrete = rateio.itens.filter(ehFrete);
  const naoFrete = rateio.itens.filter((it) => !ehFrete(it));
  const productIds = [...new Set(naoFrete.map((i) => i.product_id).filter(ehUuid))];
  const productById = await lerProdutos(db, companyId, productIds);
  const { produtos, servicos } = separarServicos(naoFrete, productById);
  if (!produtos.length) return bloqueio(422, 'NFE_SEM_PRODUTOS', MSG.semProdutos);

  const freteC = linhasFrete.reduce((s, it) =>
    s + centavos(Math.round(Number(it.quantity) * Number(it.unit_price) * 100) / 100) - centavos(it.discount), 0);
  const basesC = produtos.map((it) =>
    centavos(Math.round(Number(it.quantity) * Number(it.unit_price) * 100) / 100) - centavos(it.discount));
  const freteItens = ratearFrete(basesC, Math.max(0, freteC));

  const faltantes = [];
  const items = produtos.map((it, idx) => {
    const p = productById.get(it.product_id) || {};
    const ncm = validNcm(p.ncm);
    if (!ncm) {
      faltantes.push({
        campo: `itens[${idx}].ncm`,
        mensagem: `NCM do produto "${it.product_name || 'Item ' + (idx + 1)}" (8 números, no cadastro do produto)`,
        tipo: 'faltando',
        product_id: it.product_id || null,
      });
    }
    const tax = taxEngine.resolveItemTax({
      taxProfile: p.tax_profile || null, crt,
      icmsStPaid: p.icms_st_paid === true, origem: p.origem,
    });
    const cest = onlyDigits(p.cest);
    return {
      product_id: it.product_id || null,
      code: String(it.product_id || `item-${idx + 1}`),
      name: it.product_name || `Item ${idx + 1}`,
      ncm: ncm || '00000000',
      cest: cest.length === 7 ? cest : undefined,
      unit: (p.unit && String(p.unit).toLowerCase() !== 'srv') ? String(p.unit).toUpperCase().slice(0, 6) : 'UN',
      barcode: p.barcode || undefined,
      quantity: Number(it.quantity),
      price: Number(it.unit_price),
      discount: Number(it.discount) || 0,
      freight: freteItens[idx] / 100,
      csosn: tax.csosn, orig: tax.orig, pisCst: tax.pisCst, cofinsCst: tax.cofinsCst,
    };
  });

  const vProdC = items.reduce((s, it) => s + centavos(Math.round(it.quantity * it.price * 100) / 100), 0);
  const vDescC = items.reduce((s, it) => s + centavos(it.discount), 0);
  const vFreteC = items.reduce((s, it) => s + centavos(it.freight), 0);
  const vNF = (vProdC - vDescC + vFreteC) / 100;

  // Pagamentos reais da venda, na proporção do total da nota.
  const pagRows = await lerPagamentosDaVenda(db, saleId);
  let pagamentos = pagRows
    .map((r) => pagamentoDaNota(r.method, Number(r.amount)))
    .filter((p) => p.value > 0);
  if (!pagamentos.length) pagamentos = [pagamentoDaNota(venda.payment_method, Number(venda.total_amount) || vNF)];
  pagamentos = pagamentosDosProdutos(pagamentos, vNF);
  if (!pagamentos.length) pagamentos = [pagamentoDaNota(venda.payment_method, vNF)];

  // Destinatário
  const cliente = await lerCliente(db, companyId, venda.customer_id);
  const destR = await resolverDestinatario({
    cliente, doCorpo: b.destinatario, buscarIbge, ufEmitente,
  });
  faltantes.push(...destR.faltantes);
  const dest = destR.dest;

  // Operação
  const ufDest = dest.endereco.uf;
  if (ufDest === 'EX') return { ...bloqueio(422, 'NFE_EXTERIOR_FORA_DO_V1', MSG.exterior), faltantes };
  const interestadual = !!ufDest && ufDest !== ufEmitente;
  if (interestadual && dest.indIEDest === '9') {
    return { ...bloqueio(422, 'NFE_DIFAL_FORA_DO_V1', MSG.difal), faltantes };
  }
  const indFinal = b.consumidor_final !== undefined && b.consumidor_final !== null
    ? (b.consumidor_final ? '1' : '0')
    : (dest.indIEDest === '1' ? '0' : '1');
  const indPres = b.indicador_presenca !== undefined && b.indicador_presenca !== null && b.indicador_presenca !== ''
    ? String(b.indicador_presenca) : '1';
  if (!['0', '1', '2', '3', '4', '5', '9'].includes(indPres)) {
    faltantes.push({ campo: 'indicador_presenca', mensagem: 'Indicador de presença inválido.', tipo: 'invalido' });
  }

  // Frete / transporte
  const bf = b.frete || {};
  let modFrete = bf.modalidade !== undefined && bf.modalidade !== null && bf.modalidade !== ''
    ? String(bf.modalidade) : (vFreteC > 0 ? '0' : '9');
  if (!['0', '1', '2', '3', '4', '9'].includes(modFrete)) {
    faltantes.push({ campo: 'frete.modalidade', mensagem: 'Modalidade do frete inválida. Use 0 (por conta da loja), 1 (do cliente), 2 (terceiros), 3 ou 4 (transporte próprio) ou 9 (sem frete).', tipo: 'invalido' });
    modFrete = '9';
  }
  let transportadora = null;
  if (bf.transportadora && typeof bf.transportadora === 'object') {
    const t = bf.transportadora;
    const doc = onlyDigits(t.documento);
    if (doc && !(doc.length === 11 ? isValidCpf(doc) : doc.length === 14 ? isValidCnpj(doc) : false)) {
      faltantes.push({ campo: 'frete.transportadora.documento', mensagem: 'O CPF ou CNPJ da transportadora não confere.', tipo: 'invalido' });
    }
    transportadora = {
      documento: doc || null, nome: texto(t.nome), ie: texto(t.ie), endereco: texto(t.endereco),
      municipio: texto(t.municipio), uf: texto(t.uf) ? String(t.uf).toUpperCase() : null,
    };
  }

  const natOp = texto(b.natureza_operacao) || 'Venda de mercadoria';
  const observacoes = texto(b.observacoes);

  const itemsComCfop = items.map((it) => ({ ...it, cfop: taxEngine.cfopVenda55(it.csosn, { interestadual }) }));

  const nfeData = {
    items: itemsComCfop,
    dest: {
      cpf: dest.cpf, cnpj: dest.cnpj, nome: dest.nome, ie: dest.ie, indIEDest: dest.indIEDest, email: dest.email,
      endereco: {
        logradouro: dest.endereco.logradouro, numero: dest.endereco.numero, complemento: dest.endereco.complemento,
        bairro: dest.endereco.bairro, codigo_municipio: dest.endereco.codigo_municipio_ibge,
        municipio: dest.endereco.municipio, uf: dest.endereco.uf, cep: dest.endereco.cep, fone: dest.endereco.fone,
      },
    },
    payments: pagamentos.map((p) => ({ method: p.method, value: p.value, indPag: p.indPag })),
    natureza_operacao: natOp,
    indPres, indFinal,
    frete: { modalidade: modFrete, transportadora },
    observacoes,
  };

  const previa = {
    ambiente: config.ambiente === 'producao' ? 'producao' : 'homologacao',
    destinatario: {
      documento: dest.documento || null, nome: dest.nome, ie: dest.ie, ind_ie_dest: Number(dest.indIEDest),
      email: dest.email || null,
      endereco: {
        cep: dest.endereco.cep || null, logradouro: dest.endereco.logradouro, numero: dest.endereco.numero,
        complemento: dest.endereco.complemento, bairro: dest.endereco.bairro, municipio: dest.endereco.municipio,
        uf: dest.endereco.uf, codigo_municipio_ibge: dest.endereco.codigo_municipio_ibge,
      },
      origem: destR.origem,
      customer_id: cliente ? cliente.id : null,
    },
    operacao: {
      natureza_operacao: natOp,
      uf_emitente: ufEmitente, uf_destino: ufDest || null,
      id_dest: interestadual ? 2 : 1, ind_final: Number(indFinal), ind_ie_dest: Number(dest.indIEDest),
      ind_pres: Number(indPres),
    },
    itens: itemsComCfop.map((it) => ({
      product_id: it.product_id, nome: it.name, ncm: it.ncm === '00000000' ? null : it.ncm, cest: it.cest || null,
      unidade: it.unit, quantidade: it.quantity, valor_unitario: it.price,
      valor_bruto: centavos(Math.round(it.quantity * it.price * 100) / 100) / 100,
      desconto: it.discount, frete: it.freight,
      valor_total: (centavos(Math.round(it.quantity * it.price * 100) / 100) - centavos(it.discount) + centavos(it.freight)) / 100,
      cfop: it.cfop, csosn: it.csosn, origem: Number(it.orig),
    })),
    pagamentos: pagamentos.map((p) => ({ forma: p.forma, tPag: p.method, valor: p.value, a_prazo: p.indPag === 1 })),
    totais: { produtos: vProdC / 100, desconto: vDescC / 100, frete: vFreteC / 100, nota: vNF },
    frete: { modalidade: Number(modFrete), transportadora },
    ...(servicos.length ? { servicos_fora_da_nota: { itens: servicos.length } } : {}),
  };

  return { bloqueio: null, faltantes, company, config, venda, cliente, nfeData, previa };
}

// ── Gravar no cadastro do cliente ───────────────────────────

/**
 * Grava IE/indicador/IBGE/endereço no customer (salvar_no_cadastro).
 * Base sem a migration 450 grava só o endereço e devolve ignored_fields.
 */
async function salvarNoCadastro(db, companyId, customerId, dest) {
  if (!ehUuid(String(customerId || ''))) return { salvo: false, motivo: 'venda_sem_cliente' };
  const donos = await lojasDoDono(db, companyId);
  const e = dest.endereco || {};
  const base = {
    cpf_cnpj: dest.documento || null, name: dest.nome || null, email: dest.email || null,
    zip_code: e.cep || null, street: e.logradouro || null, number: e.numero || null,
    complement: e.complemento || null, neighborhood: e.bairro || null, city: e.municipio || null,
    state: e.uf || null,
  };
  const novos = {
    ie: dest.ie || (dest.indIEDest === '2' ? 'ISENTO' : null),
    ind_ie_dest: Number(dest.indIEDest) || null,
    codigo_municipio_ibge: e.codigo_municipio_ibge || null,
  };
  const grava = async (campos) => {
    const cols = Object.keys(campos).filter((k) => campos[k] !== null && campos[k] !== undefined);
    if (!cols.length) return;
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    await db.query(
      `UPDATE customers SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND company_id = ANY($${cols.length + 2})`,
      [customerId, ...cols.map((c) => campos[c]), donos]
    );
  };
  if (temColunasNfe55Cliente) {
    try {
      await grava({ ...base, ...novos });
      return { salvo: true };
    } catch (err) {
      if (err.code !== '42703') throw err;
      temColunasNfe55Cliente = false;
    }
  }
  await grava(base);
  return { salvo: true, ignored_fields: Object.keys(novos) };
}

module.exports = {
  montarNotaDaVenda, resolverDestinatario, notasDaVenda, nfeDeVendaQueTrava, salvarNoCadastro,
  motivoCertificado, ufsHabilitadas, mensagemUfNaoHabilitada, ieValida, ieSpValida, ratearFrete,
  pagamentoDaNota, STATUS_QUE_TRAVAM, MSG, _resetCaches,
};
