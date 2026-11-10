// ============================================================
// AURA. — Emissão AUTOMÁTICA da NFS-e (10/11/2026, migration 438)
//
// Decisões do dono:
//   1. A NFS-e sai sozinha em três momentos: venda no Caixa com serviço,
//      OS concluída (status 'entregue') e pagamento recebido (crediário).
//      A MESMA prestação nunca gera duas notas: o primeiro gatilho emite e os
//      outros só anotam o vínculo.
//   2. Tomador OPCIONAL (decisão de 10/11/2026, como o Emissor Nacional
//      permite): sem CPF/CNPJ a nota sai SEM o grupo <toma> (consumidor não
//      identificado). Com documento: dígito errado NUNCA emite (pendente
//      TOMADOR_INVALIDO) e sem nome nenhum (nem do cliente da venda) fica
//      pendente SEM_NOME — o <toma> exige xNome. ISSQN retido exige o
//      tomador (SEM_TOMADOR). Pendências o app completa e emite.
//   3. Venda mista: só os itens da NFS-e (notaDoItem.vaiNaNfse: products.
//      nota_fiscal, ou sem escolha unit = 'srv') vão para a NFS-e;
//      os produtos seguem na NFC-e (outro fluxo, não mexemos aqui).
//
// Prestação = (empresa, origem, código de tributação). A origem é a venda ou
// a OS; o pagamento nunca é origem — aponta para a venda que está pagando.
// OS concluída com venda ligada (service_orders.sale_id) cuja venda tem
// serviço: a prestação é a da VENDA (a OS não emite de novo).
//
// Cada DPS tem um único cTribNac: os itens são agrupados pelo código do item
// (products.nfse_ctribnac, migration 437 do PR 1) ou, sem ele, pelo padrão
// da empresa (nfse_config.ctribnac_padrao). Uma nota por código.
//
// Idempotência em duas camadas:
//   - nfse_automatica UNIQUE (company_id, origem_tipo, origem_id, ctribnac):
//     o INSERT ... ON CONFLICT decide quem tem a vez; retomar é um UPDATE
//     condicional (só um processo passa de 'erro'/'pendente_dados' para
//     'emitindo');
//   - a chave enviada ao emissor é derivada da origem
//     (aura-auto-<tipo>-<id>-<código>-<tentativa>) e o emissor nacional tem
//     UNIQUE (company_id, idempotency_key): mesmo que dois processos
//     passassem, sai uma nota só.
//
// NUNCA atrasa nem derruba a venda/OS/recebimento: os gatilhos (aoFinalizar
// Venda, aoConcluirOs, aoReceberPagamento) só agendam com setImmediate,
// depois do COMMIT, e engolem qualquer erro (vira registro 'erro' + log).
//
// Tomador (quem contratou), do mais forte para o mais fraco:
//   1. o completado pelo app (POST .../completar ou "Emitir" com tomador),
//      agora ou numa tentativa anterior (nfse_automatica.tomador);
//   2. o informado no Caixa junto com a venda (POST /pdv/sale nfse_tomador,
//      gravado em sales.nfse_tomador na transação da venda, migration 440);
//   3. o cadastro do cliente da venda/OS (customers.cpf_cnpj + nome).
// Nenhum deles cria ou altera cadastro de cliente. Nenhum com documento:
// a nota sai sem tomador (consumidor não identificado, decisão 2).
//
// Ligas da AUTOMÁTICA: NFSE_AUTOMATICA_ENABLED=true no servidor E nfse_config.
// emissao_automatica=true na empresa (provider 'nacional', ativa). Com
// qualquer uma desligada os gatilhos não fazem nem uma consulta ao banco.
// Venda/OS anterior a nfse_config.emissao_automatica_desde não emite sozinha.
//
// Emissão MANUAL ("Emitir NFS-e" no Caixa, 10/11/2026): a lojista aperta o
// botão. Não depende da automática (nem da flag, nem do opt-in): basta a
// loja emitir NFS-e — nfse_config.is_active=true, provider 'nacional' e
// NFSE_NACIONAL_ENABLED no servidor (lojaEmite). A idempotência é a mesma
// da automática (UNIQUE por prestação + chave derivada da origem): o botão
// apertado duas vezes, ou o botão depois de um gatilho, nunca gera duas notas.
// ============================================================
'use strict';

const db = require('../config/database');
const repo = require('./nfseAutomaticaRepo');
const nacional = require('./nfseNacional');
const { NfseNacionalError } = require('./nfseNacional/errors');
const { hojeBR } = require('./nfseNacional/dpsBuilder');
const { nacionalHabilitado } = require('./nfseNacional/endpoints');
const { isValidCpf, isValidCnpj } = require('../utils/cpfCnpj');
const { vaiNaNfse } = require('./notaDoItem'); // migration 442: o item escolhe a nota

// ── DECISÕES DO DONO EM 10/11/2026 — cada uma num ponto só ──────────────
// (a) A OS dispara a nota quando passa para este status (não 'pronta').
const STATUS_OS_QUE_EMITE = 'entregue';
// (b) Venda/cobrança parcelada: UMA NFS-e pelo total da prestação, no
//     primeiro gatilho que acontecer; parcelas pagas depois não emitem de
//     novo (idempotência pela origem). true = valor cheio no 1º gatilho.
const UMA_NOTA_PELO_TOTAL_NO_PRIMEIRO_GATILHO = true;
// (c) Serviço sem código de tributação nacional (nem no item nem padrão da
//     empresa): a venda fecha normal e a prestação fica com problema (status
//     'erro', motivo_codigo SEM_CODIGO). Nenhuma nota da prestação sai até o
//     código existir — assim os itens nunca se dividem entre notas por acaso.
//     O registro usa este código-sentinela e some quando o código aparece.
const CTRIBNAC_SEM_CODIGO = '000000';
// ────────────────────────────────────────────────────────────────────────

const STALE_SEG = 10 * 60; // 'emitindo' parado há 10 min = processo caiu no meio
const MAX_DESCRICAO = 2000;
const TIPOS = new Set(['venda', 'os']);
const SOURCE_TYPE = { venda: 'pdv_sale', os: 'service_order' };

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function ligadaNoServidor() {
  const v = String(process.env.NFSE_AUTOMATICA_ENABLED || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

function optInAtivo(cfg) {
  return !!(cfg && cfg.emissao_automatica === true && cfg.provider === 'nacional' && cfg.is_active !== false);
}

/**
 * A loja emite NFS-e (vale para o botão manual): NFS-e ligada na loja
 * (is_active=true), Emissor Nacional e o emissor ligado no servidor.
 * Independe da emissão automática.
 */
function lojaEmite(cfg) {
  return !!(cfg && cfg.is_active === true && cfg.provider === 'nacional' && nacionalHabilitado());
}

// ── mensagens (chegam à tela da lojista) ─────────────────────
const MSG = {
  SEM_TOMADOR: 'Com ISS retido pelo cliente, a NFS-e precisa do CPF/CNPJ de quem contratou o serviço. Complete os dados para emitir.',
  TOMADOR_INVALIDO: 'O CPF/CNPJ de quem contratou o serviço parece incorreto. Confira e complete os dados para emitir a NFS-e.',
  SEM_NOME: 'Falta o nome de quem contratou o serviço. Complete os dados para emitir a NFS-e.',
  SEM_CODIGO: 'Falta o código de tributação nacional do serviço. Cadastre o código no serviço (ou o código padrão em Configurações > Nota Fiscal) e tente de novo.',
  AGUARDANDO: 'Nota enviada. Estamos aguardando a confirmação do Sistema Nacional.',
  INESPERADO: 'Não conseguimos emitir a NFS-e agora. Nada foi perdido: tente de novo em instantes.',
  LOJA_NAO_EMITE: 'A NFS-e ainda não está ligada nesta loja. Ligue em Notas fiscais > "Pronto para emitir NFS-e?" e tente de novo.',
};

function mensagemDoEmissor(err) {
  const m = String((err && err.message) || '').trim();
  return m ? `Não conseguimos emitir a NFS-e: ${m}` : MSG.INESPERADO;
}

// ── regras puras ─────────────────────────────────────────────

/**
 * Tomador da nota: o informado pelo app vale mais que o cadastro do cliente.
 * Opcional (10/11/2026): sem documento em lugar nenhum a nota sai sem
 * tomador (consumidor não identificado) — salvo com ISSQN retido
 * (opts.exigir), que exige o tomador identificado.
 * Informado sem documento não conta: vale o cadastro do cliente inteiro.
 * Documento sem nome usa o nome do cliente da venda/OS.
 * @returns {{ ok: true, tomador: object|null } | { ok: false, codigo, motivo }}
 */
function resolverTomador(informado, cliente, opts = {}) {
  const fonte = informado && onlyDigits(informado.doc) ? informado : null;
  const doc = onlyDigits(fonte ? fonte.doc : cliente && cliente.cpf_cnpj);
  const nomeDoCliente = (cliente && (cliente.full_name || cliente.name)) || '';
  const nome = String((fonte && fonte.nome) || nomeDoCliente || '').trim();
  const email = String((fonte && fonte.email) || (cliente && cliente.email) || '').trim();
  const fone = onlyDigits((fonte && fonte.fone) || (cliente && cliente.phone));

  if (!doc) {
    if (opts.exigir) return { ok: false, codigo: 'SEM_TOMADOR', motivo: MSG.SEM_TOMADOR };
    return { ok: true, tomador: null };
  }
  const valido = doc.length === 11 ? isValidCpf(doc) : doc.length === 14 ? isValidCnpj(doc) : false;
  if (!valido) return { ok: false, codigo: 'TOMADOR_INVALIDO', motivo: MSG.TOMADOR_INVALIDO };
  // nome que é só o próprio documento (cadastro feito só com o CPF) não serve
  if (!nome || onlyDigits(nome) === nome.replace(/\s/g, '')) {
    return { ok: false, codigo: 'SEM_NOME', motivo: MSG.SEM_NOME };
  }
  return {
    ok: true,
    tomador: {
      doc,
      nome: nome.slice(0, 300),
      // e-mail fora do formato derrubaria a DPS inteira: sem ele a nota sai igual
      email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 80 ? email : null,
      fone: fone.length >= 10 && fone.length <= 13 ? fone : null,
    },
  };
}

/**
 * nfse_tomador do corpo do POST /pdv/sale: { doc, nome? }.
 * Nunca recusa a venda: ausente → nada; inválido → ignorado com aviso
 * (quem chama registra no log, sem o documento).
 * @returns {{ tomador: { doc, nome } | null, aviso: string | null }}
 */
function tomadorDaVendaDoCorpo(raw) {
  if (raw == null || raw === '') return { tomador: null, aviso: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { tomador: null, aviso: 'FORMATO' };
  const doc = onlyDigits(raw.doc);
  if (!doc) return { tomador: null, aviso: raw.doc == null || String(raw.doc).trim() === '' ? null : 'TOMADOR_INVALIDO' };
  const valido = doc.length === 11 ? isValidCpf(doc) : doc.length === 14 ? isValidCnpj(doc) : false;
  if (!valido) return { tomador: null, aviso: 'TOMADOR_INVALIDO' };
  const nome = raw.nome == null ? '' : String(raw.nome).trim().slice(0, 300);
  return { tomador: { doc, nome: nome || null }, aviso: null };
}

/**
 * Itens de serviço → grupos por cTribNac. Desconto da venda (cupom/manual)
 * é rateado no valor dos serviços: a nota sai pelo que foi cobrado.
 * @param itens [{ id, descricao, quantidade, valor, servico, ctribnac?, cnbs? }]
 * @param fator  total cobrado / soma dos itens (≤ 1)
 * @returns {{ grupos: [{ ctribnac, cnbs, descricao, valor, itens }], semCodigo: boolean, itensSemCodigo }}
 */
function agruparPorCodigo(itens, cfg, fator = 1) {
  const porCodigo = new Map();
  let semCodigo = false;
  const itensSemCodigo = [];
  for (const it of itens) {
    if (!it.servico) continue;
    const codigo = onlyDigits(it.ctribnac) || onlyDigits(cfg && cfg.ctribnac_padrao);
    const valor = round2(Number(it.valor) * fator);
    if (!(valor > 0)) continue;
    if (!/^\d{6}$/.test(codigo) || codigo === CTRIBNAC_SEM_CODIGO) {
      semCodigo = true;
      itensSemCodigo.push({ id: it.id, descricao: it.descricao, quantidade: Number(it.quantidade) || 1, valor });
      continue;
    }
    if (!porCodigo.has(codigo)) {
      porCodigo.set(codigo, { ctribnac: codigo, cnbs: null, partes: [], valor: 0, itens: [] });
    }
    const g = porCodigo.get(codigo);
    const cnbs = onlyDigits(it.cnbs);
    if (!g.cnbs && /^\d{9}$/.test(cnbs)) g.cnbs = cnbs;
    const qtd = Number(it.quantidade) || 1;
    g.partes.push(`${qtd !== 1 ? `${String(qtd).replace('.', ',')}x ` : ''}${String(it.descricao || 'Serviço').trim()}`);
    g.valor = round2(g.valor + valor);
    g.itens.push({ id: it.id, descricao: it.descricao, quantidade: qtd, valor });
  }
  const grupos = [...porCodigo.values()].map((g) => ({
    ctribnac: g.ctribnac,
    cnbs: g.cnbs || onlyDigits(cfg && cfg.cnbs_padrao) || null,
    descricao: g.partes.join('; ').slice(0, MAX_DESCRICAO),
    valor: g.valor,
    itens: g.itens,
  }));
  return { grupos, semCodigo, itensSemCodigo };
}

function chaveDeIdempotencia(origemTipo, origemId, ctribnac, tentativa) {
  return `aura-auto-${origemTipo}-${origemId}-${ctribnac}-${tentativa}`;
}

/** Situação viva de um registro: a nota no emissor manda (ex.: cancelada depois). */
function estadoDoRegistro(row) {
  if (row.nfse_id && row.nfse_status) {
    const s = row.nfse_status;
    if (s === 'autorizada') return 'emitida';
    if (s === 'cancelada') return 'cancelada';
    if (s === 'rejeitada') return 'rejeitada';
    if (s === 'erro') return 'erro';
    return 'emitindo'; // pendente / processando: aguardando confirmação
  }
  return row.status;
}

/** Resumo da origem para a tela de venda/OS concluída. */
function resumirOrigem(rows) {
  const notas = rows.map((r) => ({
    id: r.id,
    origem_tipo: r.origem_tipo,
    origem_id: r.origem_id,
    ctribnac: r.ctribnac,
    estado: estadoDoRegistro(r),
    motivo: estadoDoRegistro(r) === 'emitida' ? null
      : (r.motivo || (estadoDoRegistro(r) === 'rejeitada' && r.nfse_motivo ? `O Sistema Nacional recusou a NFS-e: ${r.nfse_motivo}` : null)),
    motivo_codigo: r.motivo_codigo || null,
    valor: r.valor != null ? Number(r.valor) : null,
    gatilho: r.gatilho,
    nfse_id: r.nfse_id || null,
    nfse_number: r.nfse_number || null,
    chave_acesso: r.chave_acesso || null,
    emitida_em: r.issued_at || null,
    atualizado_em: r.updated_at || null,
  }));
  const estados = new Set(notas.map((n) => n.estado));
  let estado = 'nenhuma';
  if (notas.length) {
    if (estados.has('emitindo')) estado = 'emitindo';
    else if (estados.has('pendente_dados')) estado = 'pendente_dados';
    else if (estados.has('erro') || estados.has('rejeitada')) estado = 'erro';
    else if (estados.has('emitida')) estado = 'emitida';
    else estado = 'cancelada';
  }
  const temNota = estados.has('emitida');
  let acao = {
    nenhuma: 'emitir', emitindo: 'aguardar', pendente_dados: 'completar_dados',
    erro: 'tentar_de_novo', emitida: 'imprimir_2a_via', cancelada: 'emitir',
  }[estado];
  // regra (c): o app leva ao cadastro do serviço antes de tentar de novo
  if (estado === 'erro' && notas.some((n) => n.motivo_codigo === 'SEM_CODIGO')) acao = 'cadastrar_codigo';
  return { estado, acao, tem_nota: temNota, notas };
}

// ── núcleo ───────────────────────────────────────────────────

function itemDaVenda(r) {
  return {
    id: r.id,
    servico: vaiNaNfse(r),
    descricao: r.nfse_descricao || r.product_name_snapshot || r.product_name,
    quantidade: r.quantity,
    valor: Number(r.total_price) || 0,
    ctribnac: r.nfse_ctribnac || null,
    cnbs: r.nfse_cnbs || null,
  };
}

function itemDaOs(r) {
  return {
    id: r.id,
    servico: vaiNaNfse({ nota_fiscal: r.nota_fiscal, unit: r.kind === 'servico' ? 'srv' : r.unit }),
    descricao: r.nfse_descricao || r.description || r.product_name,
    quantidade: r.quantity,
    valor: Number(r.total_price) || 0,
    ctribnac: r.nfse_ctribnac || null,
    cnbs: r.nfse_cnbs || null,
  };
}

function anteriorAoOptIn(cfg, quando) {
  if (!cfg || !cfg.emissao_automatica_desde || !quando) return false;
  return new Date(quando).getTime() < new Date(cfg.emissao_automatica_desde).getTime();
}

/**
 * Decide se este gatilho pega a vez do registro da prestação.
 * @returns {{ row, vez: boolean }}
 */
async function pegarVez(p, { forcar }) {
  const r = await repo.reivindicar(p);
  if (r.criado) return { row: r.row, vez: true };
  const row = r.row;
  if (!row) return { row: null, vez: false };
  const estado = estadoDoRegistro(row);
  const itens = p.itens;
  const valor = p.valor;
  // Concorrência otimista: só passa quem ainda vê o MESMO status que leu
  // (um 'emitindo' de outro processo só é retomado depois de parado 10 min).
  if ((estado === 'pendente_dados' || estado === 'erro') && row.status !== 'emitindo') {
    // erro retoma com a MESMA chave (o emissor retoma sem renumerar)
    const novo = await repo.retomar(row.id, { de: [row.status], itens, valor });
    return novo ? { row: novo, vez: true } : { row, vez: false };
  }
  if (estado === 'emitindo' || row.status === 'emitindo') {
    const novo = await repo.retomar(row.id, { de: [], staleSeg: STALE_SEG, itens, valor });
    return novo ? { row: novo, vez: true } : { row, vez: false };
  }
  if (forcar && (estado === 'rejeitada' || estado === 'cancelada')) {
    const novo = await repo.retomar(row.id, { de: [row.status], novaTentativa: true, itens, valor });
    return novo ? { row: novo, vez: true } : { row, vez: false };
  }
  return { row, vez: false }; // emitida (ou rejeitada/cancelada sem pedido explícito)
}

async function emitirGrupo(ctx, grupo) {
  const {
    companyId, origemTipo, origemId, gatilho, ref, customerId, competencia, tomadorInformado, forcar,
    tomadorDaVenda = null, issRetido = false,
  } = ctx;
  const { row, vez } = await pegarVez({
    companyId, origemTipo, origemId, ctribnac: grupo.ctribnac, gatilho,
    itens: grupo.itens, valor: grupo.valor, customerId,
  }, { forcar });

  if (!row) return { ctribnac: grupo.ctribnac, acao: 'nada' };
  if (!vez) {
    if (gatilho !== row.gatilho || ref) {
      try {
        await repo.anotarVinculo(row.id, { gatilho, ref: ref || null, em: new Date().toISOString() });
      } catch (_) { /* vínculo é rastro, não regra */ }
    }
    return { ctribnac: grupo.ctribnac, acao: 'ja_existe', registro_id: row.id, estado: estadoDoRegistro(row) };
  }

  // Tomador: o completado pelo app (agora ou antes) > o informado no Caixa
  // com a venda > o cadastro do cliente. Sem documento em nenhum: a nota sai
  // sem tomador (consumidor não identificado). A automática hoje não retém
  // ISSQN; se um dia retiver (issRetido), o tomador volta a ser obrigatório.
  const informado = tomadorInformado || row.tomador || tomadorDaVenda || null;
  const cliente = informado && informado.doc && informado.nome ? null : await repo.buscarCliente(customerId);
  const tom = resolverTomador(informado, cliente, { exigir: issRetido === true });
  if (!tom.ok) {
    await repo.gravar(row.id, {
      status: 'pendente_dados', motivo: tom.motivo, motivo_codigo: tom.codigo,
      tomador: tomadorInformado || row.tomador || tomadorDaVenda || null,
    });
    return { ctribnac: grupo.ctribnac, acao: 'pendente_dados', registro_id: row.id, motivo: tom.motivo };
  }

  let nota = {
    descricao: grupo.descricao,
    valor: grupo.valor,
    competencia,
    ctribnac: grupo.ctribnac,
    cnbs: grupo.cnbs || undefined,
    customer_id: customerId || undefined,
    source_type: SOURCE_TYPE[origemTipo],
    ...(tom.tomador ? { tomador: tom.tomador } : {}),
    ...(issRetido === true ? { iss_retido: true } : {}),
  };
  // Dados mudaram desde a tentativa anterior (tomador completado, venda
  // editada): chave nova — a mesma chave com outros dados o emissor recusa.
  // Só abandona a chave anterior se a nota dela está morta (erro antes de
  // processar, rejeitada, cancelada). Pendente no Sistema Nacional (pode
  // virar nota) ou autorizada: segue com os MESMOS dados e a MESMA chave —
  // nunca duas notas vivas para a mesma prestação.
  let tentativa = row.tentativa || 1;
  const mesmaChave = row.idempotency_key === chaveDeIdempotencia(origemTipo, origemId, grupo.ctribnac, tentativa);
  if (mesmaChave && row.nota && nacional.fingerprint(row.nota) !== nacional.fingerprint(nota)) {
    const anterior = await repo.notaPorChave(companyId, row.idempotency_key);
    if (anterior && ['erro', 'rejeitada', 'cancelada'].includes(anterior.status)) tentativa += 1;
    else if (anterior) nota = row.nota;
  }
  const key = chaveDeIdempotencia(origemTipo, origemId, grupo.ctribnac, tentativa);
  await repo.gravar(row.id, {
    nota, idempotency_key: key, tentativa,
    tomador: tomadorInformado || row.tomador || tomadorDaVenda || null,
  });

  try {
    const r = await nacional.emitir(db, { companyId, idempotencyKey: key, nota });
    const n = r.nota || {};
    if (n.id) await repo.ligarNotaAOrigem(companyId, n.id, origemId);
    let status = 'emitindo';
    let motivo = null;
    if (n.status === 'autorizada') status = 'emitida';
    else if (n.status === 'rejeitada') { status = 'rejeitada'; motivo = `O Sistema Nacional recusou a NFS-e: ${n.rejection_reason || 'sem detalhe'}`; }
    else if (n.status === 'cancelada') status = 'cancelada';
    else if (n.status === 'erro') { status = 'erro'; motivo = mensagemDoEmissor({ message: n.rejection_reason }); }
    else motivo = MSG.AGUARDANDO;
    await repo.gravar(row.id, { status, motivo, motivo_codigo: null, nfse_id: n.id || null });
    return { ctribnac: grupo.ctribnac, acao: status, registro_id: row.id, nfse_id: n.id || null, motivo };
  } catch (err) {
    const conhecido = err instanceof NfseNacionalError;
    if (!conhecido) console.error('[nfse automatica] emissão falhou:', err && err.message);
    const motivo = conhecido ? mensagemDoEmissor(err) : MSG.INESPERADO;
    let nfseId = null;
    try { const ja = await repo.notaPorChave(companyId, key); nfseId = ja ? ja.id : null; } catch (_) { /* noop */ }
    await repo.gravar(row.id, {
      status: 'erro', motivo, motivo_codigo: conhecido ? err.code : 'INESPERADO', nfse_id: nfseId,
    });
    return { ctribnac: grupo.ctribnac, acao: 'erro', registro_id: row.id, motivo };
  }
}

/**
 * Processa uma venda do Caixa.
 * @param p { companyId, saleId, gatilho, ref?, manual?, forcar?, tomador?, tomadorDaVenda?, cfg? }
 *   tomador        = completado pelo app (vale mais que tudo)
 *   tomadorDaVenda = informado no Caixa com a venda (em memória, no gatilho
 *                    da venda); sem ele, vale o gravado em sales.nfse_tomador
 * @returns {{ acao, motivo?, grupos? }}
 */
async function processarVenda(p) {
  const { companyId, saleId, gatilho, ref = null, manual = false, forcar = false, tomador = null } = p;
  const cfg = p.cfg !== undefined ? p.cfg : await repo.carregarConfig(companyId);
  if (!manual && !optInAtivo(cfg)) return { acao: 'nada', motivo: 'desligada' };
  const venda = await repo.buscarVenda(companyId, saleId);
  if (!venda) return { acao: 'nada', motivo: 'venda_nao_encontrada' };
  if (venda.status === 'cancelled' || venda.type === 'troca') return { acao: 'nada', motivo: 'venda_fora' };
  if (!manual && anteriorAoOptIn(cfg, venda.created_at)) return { acao: 'nada', motivo: 'anterior_ao_opt_in' };

  const linhas = await repo.itensDaVenda(companyId, saleId);
  const itens = linhas.map(itemDaVenda);
  const soma = itens.reduce((s, i) => s + i.valor, 0);
  const total = Number(venda.total_amount);
  const fator = soma > 0 && Number.isFinite(total) && total >= 0 && total < soma ? total / soma : 1;
  const ctx = {
    companyId, origemTipo: 'venda', origemId: venda.id, gatilho, ref,
    customerId: venda.customer_id, competencia: hojeBR(venda.created_at ? new Date(venda.created_at) : new Date()),
    tomadorInformado: tomador, forcar,
    tomadorDaVenda: tomadorValido(p.tomadorDaVenda) || tomadorValido(venda.nfse_tomador),
  };
  return emitirPrestacao(ctx, agruparPorCodigo(itens, cfg, fator));
}

/** Tomador da venda com dígito conferido, ou null (aí vale o cadastro do cliente). */
function tomadorValido(t) {
  return tomadorDaVendaDoCorpo(t).tomador;
}

/**
 * Regra (c): com serviço sem código, a prestação inteira fica com problema
 * (registro-sentinela) e nada sai. Com todos os códigos, o sentinela some e
 * sai uma nota por código.
 */
async function emitirPrestacao(ctx, { grupos, semCodigo, itensSemCodigo }) {
  if (semCodigo) {
    const valor = round2(itensSemCodigo.reduce((t, i) => t + i.valor, 0));
    const r = await repo.reivindicar({
      companyId: ctx.companyId, origemTipo: ctx.origemTipo, origemId: ctx.origemId,
      ctribnac: CTRIBNAC_SEM_CODIGO, gatilho: ctx.gatilho, itens: itensSemCodigo, valor, customerId: ctx.customerId,
    });
    if (r.row) {
      await repo.gravar(r.row.id, { status: 'erro', motivo: MSG.SEM_CODIGO, motivo_codigo: 'SEM_CODIGO' });
    }
    return { acao: 'erro', codigo: 'SEM_CODIGO', motivo: MSG.SEM_CODIGO, registro_id: r.row ? r.row.id : null };
  }
  if (!grupos.length) return { acao: 'nada', motivo: 'sem_servico' };
  await repo.removerSemCodigo(ctx.companyId, ctx.origemTipo, ctx.origemId, CTRIBNAC_SEM_CODIGO);
  const resultados = [];
  for (const g of grupos) resultados.push(await emitirGrupo(ctx, g));
  return { acao: 'processada', grupos: resultados };
}

/**
 * Processa uma OS concluída. Com venda ligada que tem serviço, a prestação é
 * a da venda (processarVenda com gatilho 'os').
 */
async function processarOs(p) {
  const { companyId, osId, gatilho = 'os', manual = false, forcar = false, tomador = null } = p;
  const cfg = p.cfg !== undefined ? p.cfg : await repo.carregarConfig(companyId);
  if (!manual && !optInAtivo(cfg)) return { acao: 'nada', motivo: 'desligada' };
  const os = await repo.buscarOs(companyId, osId);
  if (!os) return { acao: 'nada', motivo: 'os_nao_encontrada' };
  if (os.status !== STATUS_OS_QUE_EMITE) return { acao: 'nada', motivo: 'os_nao_concluida' };
  if (!manual && anteriorAoOptIn(cfg, os.delivered_at)) return { acao: 'nada', motivo: 'anterior_ao_opt_in' };

  if (os.sale_id) {
    const linhasVenda = await repo.itensDaVenda(companyId, os.sale_id);
    if (linhasVenda.some(vaiNaNfse)) {
      return processarVenda({
        companyId, saleId: os.sale_id, gatilho, ref: os.id, manual: true, forcar, tomador, cfg,
      });
    }
  }

  const itens = (await repo.itensDaOs(companyId, osId)).map(itemDaOs);
  const ctx = {
    companyId, origemTipo: 'os', origemId: os.id, gatilho, ref: null,
    customerId: os.customer_id, competencia: hojeBR(os.delivered_at ? new Date(os.delivered_at) : new Date()),
    tomadorInformado: tomador, forcar,
  };
  return emitirPrestacao(ctx, agruparPorCodigo(itens, cfg, 1));
}

/** Recebimento do crediário: emite pelas vendas das parcelas cobertas. */
async function processarPagamento({ companyId, saleIds = [], installmentIds = [], ref = null }) {
  const cfg = await repo.carregarConfig(companyId);
  if (!optInAtivo(cfg)) return { acao: 'nada', motivo: 'desligada' };
  const ids = new Set(saleIds.filter(Boolean).map(String));
  for (const s of await repo.vendasDasParcelas(companyId, installmentIds)) ids.add(String(s));
  const vendas = [];
  for (const saleId of ids) {
    vendas.push(await processarVenda({ companyId, saleId, gatilho: 'pagamento', ref, cfg }));
  }
  return { acao: vendas.length ? 'processada' : 'nada', vendas };
}

// ── emissão manual (botão "Emitir NFS-e") ────────────────────

/**
 * "Emitir NFS-e" / completar / tentar de novo, pela lojista. Recusa (sem
 * tocar no banco além da config) se a loja não emite NFS-e. Não olha a flag
 * nem o opt-in da automática.
 * @param p { companyId, tipo: 'venda'|'os', id, tomador?, forcar?, cfg? }
 * @returns {{ acao, motivo?, ... }}  acao 'recusada' + codigo LOJA_NAO_EMITE
 */
async function emitirManual(p) {
  const { companyId, tipo, id, tomador = null, forcar = false } = p;
  const cfg = p.cfg !== undefined ? p.cfg : await repo.carregarConfig(companyId);
  if (!lojaEmite(cfg)) return { acao: 'recusada', codigo: 'LOJA_NAO_EMITE', motivo: MSG.LOJA_NAO_EMITE };
  const base = { companyId, gatilho: 'manual', manual: true, forcar, tomador, cfg };
  if (tipo === 'os') return processarOs({ ...base, osId: id });
  return processarVenda({ ...base, saleId: id });
}

// ── gatilhos (fire-and-forget, depois do COMMIT) ─────────────

let agendar = (fn) => setImmediate(fn);

function disparar(onde, fn) {
  try {
    if (!ligadaNoServidor()) return false;
    agendar(() => Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`[nfse automatica ${onde}]`, err && err.code, err && err.message)));
    return true;
  } catch (_) {
    return false; // agendar nunca derruba quem chamou
  }
}

/**
 * POST /pdv/sale (e /sale-com-sinal) depois do COMMIT. tomador = o
 * nfse_tomador já validado da venda (o mesmo gravado em sales.nfse_tomador);
 * em memória para não depender da migration 440 no gatilho da própria venda.
 */
function aoFinalizarVenda({ companyId, saleId, tomador = null }) {
  if (!companyId || !saleId) return false;
  return disparar('venda', () => processarVenda({ companyId, saleId, gatilho: 'venda', tomadorDaVenda: tomador }));
}

/** POST /service-orders/:osId/status → STATUS_OS_QUE_EMITE, depois do UPDATE. */
function aoConcluirOs({ companyId, osId }) {
  if (!companyId || !osId) return false;
  return disparar('os', () => processarOs({ companyId, osId, gatilho: 'os' }));
}

/**
 * Recebimento registrado (resultado do creditLedger.applyPayment), depois
 * do COMMIT. saleId: quando a rota já sabe a venda (baixa da encomenda).
 */
function aoReceberPagamento({ companyId, result, saleId = null }) {
  if (!companyId) return false;
  if (result && result.replayed) return false;
  const installmentIds = ((result && result.covered_installments) || []).map((c) => c && c.id).filter(Boolean);
  if (!saleId && !installmentIds.length) return false;
  const ref = (result && result.transaction && result.transaction.id) || null;
  return disparar('pagamento', () => processarPagamento({
    companyId, saleIds: saleId ? [saleId] : [], installmentIds, ref,
  }));
}

// ── leitura para o app ───────────────────────────────────────

/**
 * Situação das notas de uma origem (OS com venda ligada inclui a venda).
 * Também diz se o botão "Emitir NFS-e" cabe aqui (10/11/2026):
 *   emite       a loja emite NFS-e (lojaEmite), independente da automática;
 *   tem_servico a origem tem item da NFS-e (venda: notaDoItem.vaiNaNfse; OS: item de serviço
 *               ou venda ligada com serviço);
 *   pode_emitir emite + tem_servico + origem que gera nota (venda não
 *               cancelada nem troca; OS entregue).
 * Com registro já existente a origem tem serviço por definição: os itens
 * só são lidos quando ainda não há nada (o polling fica leve).
 */
async function situacaoDaOrigem({ companyId, tipo, id }) {
  if (!TIPOS.has(tipo)) return null;
  const origens = [{ tipo, id }];
  let elegivel = false;
  let os = null;
  if (tipo === 'os') {
    os = await repo.buscarOs(companyId, id);
    if (!os) return null;
    if (os.sale_id) origens.push({ tipo: 'venda', id: os.sale_id });
    elegivel = os.status === STATUS_OS_QUE_EMITE;
  } else {
    const venda = await repo.buscarVenda(companyId, id);
    if (!venda) return null;
    elegivel = venda.status !== 'cancelled' && venda.type !== 'troca';
  }
  const rows = await repo.listarPorOrigens(companyId, origens);
  const resumo = resumirOrigem(rows);
  let temServico = rows.length > 0;
  if (!temServico) {
    if (tipo === 'venda') {
      temServico = (await repo.itensDaVenda(companyId, id)).some(vaiNaNfse);
    } else {
      temServico = (await repo.itensDaOs(companyId, id)).map(itemDaOs).some((i) => i.servico);
      if (!temServico && os.sale_id) {
        temServico = (await repo.itensDaVenda(companyId, os.sale_id)).some(vaiNaNfse);
      }
    }
  }
  const emite = lojaEmite(await repo.carregarConfig(companyId));
  return {
    origem: { tipo, id },
    ...resumo,
    emite,
    tem_servico: temServico,
    pode_emitir: emite && temServico && elegivel,
  };
}

module.exports = {
  // gatilhos
  aoFinalizarVenda, aoConcluirOs, aoReceberPagamento,
  // núcleo (rotas e testes)
  processarVenda, processarOs, processarPagamento, situacaoDaOrigem, emitirManual,
  ligadaNoServidor, optInAtivo, lojaEmite,
  STATUS_OS_QUE_EMITE, UMA_NOTA_PELO_TOTAL_NO_PRIMEIRO_GATILHO, CTRIBNAC_SEM_CODIGO,
  // regras puras
  resolverTomador, tomadorDaVendaDoCorpo, agruparPorCodigo, chaveDeIdempotencia, estadoDoRegistro, resumirOrigem,
  MSG, TIPOS,
  _setAgendador: (fn) => { agendar = fn || ((f) => setImmediate(f)); },
};
