// ============================================================
// AURA. — Assento de temporada (13/10/2026)
//
// Um acesso extra com validade fixa (services/temporada.js) que expira
// sozinho. Estado em seat_passes (migration 374); o efeito nas telas e na
// cobranca passa pelo que ja existia:
//
//   passe aplicado  → qty SOMADA em companies.extra_seats_granted
//                     (memberSeats/gates/checkout leem so essa coluna)
//   cobranca        → syncSubscriptionSeatValue ajusta o valor da assinatura
//                     na Asaas (plano + R$ 19 x extras), mesmo mecanismo do
//                     PATCH /admin/clients/:cid/extra-seats
//   fim da validade → job diario marca 'expirado', SUBTRAI qty e refaz o valor
//
// Regras que seguram o desenho:
//   - mudar status e mexer nos assentos e' UMA instrucao SQL (CTE): nao existe
//     passe "aplicado pela metade". Duas instancias do job disputam o mesmo
//     UPDATE ... WHERE status='ativo'; so uma ganha.
//   - o assento nunca fica de graca por erro: se o ajuste na Asaas falha na
//     contratacao, os assentos sao devolvidos e nada e' concedido. Se falha na
//     expiracao/cancelamento (os assentos TEM que sair), o passe fica com
//     sync_pendente e o job refaz o valor no proximo ciclo.
//   - sem assinatura na Asaas a loja nao compra (nao ha onde cobrar); a
//     Gestao Aura concede como cortesia, sem cobranca.
//
// Todas as funcoes aceitam `deps = { db, sync, hoje }` para teste.
// ============================================================
'use strict';

const defaultDb = require('../config/database');
const { SEAT_PRICE_BRL } = require('./memberSeats');
const { PLANS } = require('./billingPricing');
const { syncSubscriptionSeatValue } = require('./seatSubscription');
const { todayBrt } = require('./subscriptionDiscount');
const temporada = require('./temporada');

class SeatPassError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'SeatPassError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Responde um SeatPassError no formato { error, code, ... }. false = nao e' nosso.
function enviarErro(res, err) {
  if (!(err instanceof SeatPassError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  return true;
}

function resolverDeps(deps = {}) {
  return {
    db: deps.db || defaultDb,
    sync: deps.sync || syncSubscriptionSeatValue,
    hoje: deps.hoje || todayBrt(),
  };
}

function tabelaAusente(err) {
  return err && err.code === '42P01';
}

function migrationPendente() {
  return new SeatPassError(503, 'MIGRATION_PENDING',
    'O assento de temporada ainda não está disponível (migration 374 pendente). Tente novamente em instantes.');
}

// Colunas devolvidas (datas como texto: o driver converteria DATE em Date local).
const PASS_COLS = `id, company_id, qty,
  to_char(starts_at, 'YYYY-MM-DD') AS starts_at,
  to_char(ends_at, 'YYYY-MM-DD') AS ends_at,
  status, asaas_ref, season, source, cortesia, unit_price,
  applied_at, ended_at, ended_reason, sync_pendente, reason, created_at`;

// ── Empresa que paga (billing owner) ─────────────────────────
async function carregarEmpresa(db, companyId) {
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.plan, o.billing_cycle, o.billing_status, o.asaas_subscription_id,
              COALESCE(o.extra_seats_granted, 0) AS extra_seats_granted
         FROM companies c
         JOIN companies o ON o.id = COALESCE(c.billing_owner_company_id, c.id)
        WHERE c.id = $1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42703') {
      throw new SeatPassError(503, 'MIGRATION_PENDING',
        'Coluna de acessos extras ainda não existe (migration 110 pendente).');
    }
    throw err;
  }
}

// Da' pra cobrar? (assinatura viva num plano que o sync sabe precificar)
function motivoSemCobranca(company) {
  if (!company.asaas_subscription_id || company.billing_status === 'cancelled') return 'sem_assinatura';
  if (!PLANS[company.plan]) return 'plano_nao_suportado';
  return null;
}

// Resultado do syncSubscriptionSeatValue → 'ok' | 'transitorio' | 'indisponivel'.
//   ok           valor ajustado (ou ja estava certo)
//   transitorio  Asaas fora / timeout: vale tentar de novo
//   indisponivel nao ha o que ajustar (sem assinatura, cancelada, inativa...)
function classificarSync(r) {
  if (!r) return 'transitorio';
  if (r.updated || r.skipped === 'value_unchanged') return 'ok';
  if (r.skipped === 'fetch_failed' || r.skipped === 'error') return 'transitorio';
  return 'indisponivel';
}

async function auditar(db, { userId = null, companyId, action, detail, metadata = {} }) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, companyId, action, detail || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[seatPass] audit_log falhou (' + action + '):', err.message);
  }
}

// ── Apresentacao ─────────────────────────────────────────────
function formatarPasse(row) {
  const agendado = row.status === 'ativo' && !row.applied_at;
  const cobranca = temporada.descreverCobranca({
    qty: row.qty,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    cortesia: row.cortesia,
    unitPrice: row.cortesia ? SEAT_PRICE_BRL : (Number(row.unit_price) || SEAT_PRICE_BRL),
  });
  return {
    id: row.id,
    qty: row.qty,
    status: row.status,
    agendado,
    aplicado: !!row.applied_at && row.status === 'ativo',
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    cortesia: !!row.cortesia,
    origem: row.source,
    sync_pendente: !!row.sync_pendente,
    encerrado_em: row.ended_at || null,
    motivo_encerramento: row.ended_reason || null,
    criado_em: row.created_at,
    cobranca,
  };
}

// ── Leitura ──────────────────────────────────────────────────
// Estado do passe da empresa (ja resolvida para a que paga).
// previaQty: devolve tambem o que seria cobrado para N assentos (tela de confirmacao).
async function estado(companyId, { previaQty = null } = {}, deps = {}) {
  const { db, hoje } = resolverDeps(deps);
  const company = await carregarEmpresa(db, companyId);
  if (!company) throw new SeatPassError(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT ${PASS_COLS} FROM seat_passes WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [company.id]
    ));
  } catch (err) {
    if (tabelaAusente(err)) throw migrationPendente();
    throw err;
  }

  const passes = rows.map(formatarPasse);
  const vivos = passes.filter((p) => p.status === 'ativo');
  const aplicados = vivos.filter((p) => p.aplicado);
  const assentosAplicados = aplicados.reduce((s, p) => s + p.qty, 0);
  const assentosAgendados = vivos.filter((p) => p.agendado).reduce((s, p) => s + p.qty, 0);
  const valorMensalAtual = Math.round(aplicados.reduce((s, p) => s + p.cobranca.valor_mensal, 0) * 100) / 100;

  const janela = temporada.janelaDoPasse(hoje);
  const semCobranca = motivoSemCobranca(company);
  const limiteRestante = Math.max(temporada.LIMITE_POR_LOJA - assentosAplicados - assentosAgendados, 0);

  const out = {
    temporada: {
      id: temporada.TEMPORADA.id,
      nome: temporada.TEMPORADA.nome,
      starts_at: temporada.TEMPORADA.starts_at,
      ends_at: temporada.TEMPORADA.ends_at,
    },
    preco_assento_mensal: SEAT_PRICE_BRL,
    pode_contratar: janela.aberta && limiteRestante > 0 && !semCobranca,
    motivo_bloqueio: !janela.aberta ? 'temporada_encerrada'
      : (limiteRestante <= 0 ? 'limite_de_assentos' : semCobranca),
    limite_restante: limiteRestante,
    assentos_ativos: assentosAplicados,
    assentos_agendados: assentosAgendados,
    valor_mensal_atual: valorMensalAtual,
    valido_ate: vivos.length ? vivos.map((p) => p.ends_at).sort().pop() : null,
    passes,
  };

  const n = parseInt(previaQty, 10);
  if (Number.isFinite(n) && n > 0 && janela.aberta) {
    out.previa = {
      qty: n,
      ...temporada.descreverCobranca({
        qty: n, starts_at: janela.starts_at, ends_at: janela.ends_at, cortesia: !!semCobranca,
      }),
    };
  }
  return out;
}

// ── Aplicar: somar os assentos e ajustar a assinatura ────────
const APLICAR_SQL = `
  WITH p AS (
    UPDATE seat_passes SET applied_at = NOW()
     WHERE id = $1 AND status = 'ativo' AND applied_at IS NULL
    RETURNING id, company_id, qty, cortesia
  ), c AS (
    UPDATE companies co
       SET extra_seats_granted = COALESCE(co.extra_seats_granted, 0) + p.qty,
           updated_at = NOW()
      FROM p
     WHERE co.id = p.company_id
    RETURNING co.id, co.plan, co.billing_cycle, co.billing_status,
              co.asaas_subscription_id, co.extra_seats_granted
  )
  SELECT p.id AS pass_id, p.qty, p.cortesia, c.id, c.plan, c.billing_cycle,
         c.billing_status, c.asaas_subscription_id, c.extra_seats_granted
    FROM p JOIN c ON c.id = p.company_id`;

// Desfaz a aplicacao. cancelar=true encerra o passe; false deixa 'ativo' e
// nao aplicado, para o job tentar de novo.
const DESFAZER_SQL = `
  WITH p AS (
    UPDATE seat_passes
       SET applied_at = NULL,
           status = CASE WHEN $2::boolean THEN 'cancelado' ELSE status END,
           ended_at = CASE WHEN $2::boolean THEN NOW() ELSE ended_at END,
           ended_reason = CASE WHEN $2::boolean THEN $3::text ELSE ended_reason END
     WHERE id = $1 AND applied_at IS NOT NULL
    RETURNING id, company_id, qty
  ), c AS (
    UPDATE companies co
       SET extra_seats_granted = GREATEST(COALESCE(co.extra_seats_granted, 0) - p.qty, 0),
           updated_at = NOW()
      FROM p
     WHERE co.id = p.company_id
    RETURNING co.id, co.plan, co.billing_cycle, co.billing_status,
              co.asaas_subscription_id, co.extra_seats_granted
  )
  SELECT p.id AS pass_id, c.id, c.plan, c.billing_cycle, c.billing_status,
         c.asaas_subscription_id, c.extra_seats_granted
    FROM p JOIN c ON c.id = p.company_id`;

function empresaDaLinha(r) {
  return {
    id: r.id,
    plan: r.plan,
    billing_cycle: r.billing_cycle,
    billing_status: r.billing_status,
    asaas_subscription_id: r.asaas_subscription_id,
    extra_seats_granted: parseInt(r.extra_seats_granted, 10) || 0,
  };
}

async function marcarSyncPendente(db, passId, pendente) {
  await db.query('UPDATE seat_passes SET sync_pendente = $2 WHERE id = $1', [passId, pendente]);
}

/**
 * Aplica o passe (soma os assentos e, se cobravel, ajusta a Asaas).
 * @param {string} passId
 * @param {{cancelarSeFalhar?: boolean, userId?: string}} opts
 *   cancelarSeFalhar: true na contratacao interativa (nada fica concedido);
 *   false no job (o passe volta a "agendado" e e' tentado de novo).
 * @returns {{aplicado:boolean, motivo?:string, sync?:object, seats?:number}}
 */
async function aplicarPasse(passId, opts = {}, deps = {}) {
  const { db, sync } = resolverDeps(deps);
  const cancelarSeFalhar = !!opts.cancelarSeFalhar;

  let rows;
  try {
    ({ rows } = await db.query(APLICAR_SQL, [passId]));
  } catch (err) {
    if (err.code === '42703') throw new SeatPassError(503, 'MIGRATION_PENDING', 'Coluna de acessos extras ainda não existe (migration 110 pendente).');
    throw err;
  }
  if (!rows.length) return { aplicado: false, motivo: 'ja_processado' };

  const r = rows[0];
  const company = empresaDaLinha(r);

  // Cortesia: ha assentos, nao ha o que cobrar.
  if (r.cortesia) {
    await auditar(db, {
      userId: opts.userId, companyId: company.id, action: 'seat_pass.applied',
      detail: `Assento de temporada (cortesia): +${r.qty}`,
      metadata: { pass_id: passId, qty: r.qty, extra_seats_granted: company.extra_seats_granted, cortesia: true },
    });
    return { aplicado: true, sync: null, seats: company.extra_seats_granted };
  }

  const resultado = await sync(company);
  const classe = classificarSync(resultado);

  if (classe !== 'ok') {
    const motivo = classe === 'transitorio' ? 'falha_asaas' : 'assinatura_indisponivel';
    const cancelar = cancelarSeFalhar || classe === 'indisponivel';
    const { rows: voltou } = await db.query(DESFAZER_SQL, [passId, cancelar, motivo]);
    if (classe === 'transitorio' && voltou.length) {
      // O PUT pode ter chegado antes do erro: devolve o valor ao total atual
      // da empresa. Se isso tambem falhar, o job refaz.
      const de = await sync(empresaDaLinha(voltou[0]));
      if (classificarSync(de) === 'transitorio') await marcarSyncPendente(db, passId, true);
    }
    await auditar(db, {
      userId: opts.userId, companyId: company.id, action: 'seat_pass.apply_failed',
      detail: `Assento de temporada não aplicado: ${motivo}`,
      metadata: { pass_id: passId, qty: r.qty, motivo, cancelado: cancelar, sync: resultado },
    });
    return { aplicado: false, motivo, sync: resultado, cancelado: cancelar };
  }

  await db.query('UPDATE seat_passes SET asaas_ref = $2 WHERE id = $1', [passId, company.asaas_subscription_id]);
  await auditar(db, {
    userId: opts.userId, companyId: company.id, action: 'seat_pass.applied',
    detail: `Assento de temporada: +${r.qty}`,
    metadata: {
      pass_id: passId, qty: r.qty, extra_seats_granted: company.extra_seats_granted,
      valor_assinatura: resultado.value, valor_anterior: resultado.previousValue, subscription_id: company.asaas_subscription_id,
    },
  });
  return { aplicado: true, sync: resultado, seats: company.extra_seats_granted };
}

// ── Encerrar: expirar ou cancelar ────────────────────────────
const ENCERRAR_SQL = `
  WITH p AS (
    UPDATE seat_passes
       SET status = $2::text, ended_at = NOW(), ended_reason = $3::text
     WHERE id = $1 AND status = 'ativo'
       AND ($4::uuid IS NULL OR company_id = $4::uuid)
    RETURNING id, company_id, qty, applied_at
  ), c AS (
    UPDATE companies co
       SET extra_seats_granted = GREATEST(COALESCE(co.extra_seats_granted, 0) - p.qty, 0),
           updated_at = NOW()
      FROM p
     WHERE co.id = p.company_id AND p.applied_at IS NOT NULL
    RETURNING co.id, co.plan, co.billing_cycle, co.billing_status,
              co.asaas_subscription_id, co.extra_seats_granted
  )
  SELECT p.id AS pass_id, p.company_id, p.qty, p.applied_at,
         c.plan, c.billing_cycle, c.billing_status, c.asaas_subscription_id, c.extra_seats_granted
    FROM p LEFT JOIN c ON c.id = p.company_id`;

/**
 * Expira ou cancela um passe vivo: tira os assentos e refaz o valor na Asaas.
 * @param {string} passId
 * @param {{status:'expirado'|'cancelado', motivo:string, companyId?:string, userId?:string}} opts
 * @returns {{encerrado:boolean, assentosRemovidos?:number, sync?:object, sync_pendente?:boolean}}
 */
async function encerrarPasse(passId, opts, deps = {}) {
  const { db, sync } = resolverDeps(deps);
  const { rows } = await db.query(ENCERRAR_SQL, [passId, opts.status, opts.motivo, opts.companyId || null]);
  if (!rows.length) return { encerrado: false };

  const r = rows[0];
  const aplicado = !!r.applied_at;
  let resultado = null;
  let pendente = false;

  if (aplicado) {
    resultado = await sync({
      id: r.company_id,
      plan: r.plan,
      billing_cycle: r.billing_cycle,
      billing_status: r.billing_status,
      asaas_subscription_id: r.asaas_subscription_id,
      extra_seats_granted: parseInt(r.extra_seats_granted, 10) || 0,
    });
    if (classificarSync(resultado) === 'transitorio') {
      pendente = true;
      await marcarSyncPendente(db, passId, true);
    }
  }

  await auditar(db, {
    userId: opts.userId, companyId: r.company_id,
    action: opts.status === 'expirado' ? 'seat_pass.expired' : 'seat_pass.cancelled',
    detail: (opts.status === 'expirado' ? 'Assento de temporada expirou' : 'Assento de temporada cancelado')
      + (aplicado ? `: -${r.qty}` : ' (ainda não tinha começado)'),
    metadata: {
      pass_id: passId, qty: r.qty, motivo: opts.motivo, aplicado,
      extra_seats_granted: aplicado ? parseInt(r.extra_seats_granted, 10) || 0 : undefined,
      valor_assinatura: resultado ? resultado.value : undefined,
      sync: resultado ? (resultado.updated ? 'ajustado' : resultado.skipped) : undefined,
      sync_pendente: pendente,
    },
  });

  return { encerrado: true, aplicado, assentosRemovidos: aplicado ? r.qty : 0, sync: resultado, sync_pendente: pendente };
}

// ── Contratar ────────────────────────────────────────────────
/**
 * @param {{companyId:string, qty:any, source:'loja'|'admin', userId?:string, reason?:string}} args
 */
async function contratar({ companyId, qty, source, userId = null, reason = null }, deps = {}) {
  const { db, hoje } = resolverDeps(deps);

  const n = Number(qty);
  const teto = source === 'admin' ? temporada.LIMITE_ADMIN : temporada.LIMITE_POR_LOJA;
  if (!Number.isInteger(n) || n < 1 || n > teto) {
    throw new SeatPassError(400, 'QTY_INVALIDA', `qty deve ser um inteiro entre 1 e ${teto}`);
  }

  const janela = temporada.janelaDoPasse(hoje);
  if (!janela.aberta) {
    throw new SeatPassError(409, 'TEMPORADA_ENCERRADA',
      `A temporada terminou em ${temporada.dataBr(temporada.TEMPORADA.ends_at)}. Não há mais assento de temporada para contratar.`);
  }

  const company = await carregarEmpresa(db, companyId);
  if (!company) throw new SeatPassError(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');

  const semCobranca = motivoSemCobranca(company);
  if (semCobranca && source !== 'admin') {
    throw new SeatPassError(409, semCobranca.toUpperCase(),
      semCobranca === 'sem_assinatura'
        ? 'Para contratar o assento de temporada a empresa precisa ter uma assinatura ativa. Assine um plano e tente de novo.'
        : 'O plano atual não permite contratar assento de temporada por aqui. Fale com o suporte.');
  }
  const cortesia = !!semCobranca; // so chega aqui se source==='admin'

  let somaViva;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS total FROM seat_passes WHERE company_id = $1 AND status = 'ativo'`,
      [company.id]
    );
    somaViva = rows[0] ? parseInt(rows[0].total, 10) || 0 : 0;
  } catch (err) {
    if (tabelaAusente(err)) throw migrationPendente();
    throw err;
  }
  if (somaViva + n > teto) {
    throw new SeatPassError(409, 'LIMITE_DE_ASSENTOS',
      `O limite é de ${teto} assentos de temporada por empresa (já há ${somaViva}).`, { limite: teto, ja_contratados: somaViva });
  }

  let passId;
  try {
    const { rows } = await db.query(
      `INSERT INTO seat_passes
         (company_id, qty, starts_at, ends_at, status, season, source, cortesia, unit_price, created_by, reason)
       VALUES ($1, $2, $3::date, $4::date, 'ativo', $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [company.id, n, janela.starts_at, janela.ends_at, temporada.TEMPORADA.id,
        source === 'admin' ? 'admin' : 'loja', cortesia, cortesia ? 0 : SEAT_PRICE_BRL, userId, reason]
    );
    passId = rows[0].id;
  } catch (err) {
    if (tabelaAusente(err)) throw migrationPendente();
    throw err;
  }

  await auditar(db, {
    userId, companyId: company.id, action: 'seat_pass.created',
    detail: `Assento de temporada contratado: ${n}`,
    metadata: { pass_id: passId, qty: n, source, cortesia, starts_at: janela.starts_at, ends_at: janela.ends_at, reason },
  });

  if (janela.aplica_agora) {
    const r = await aplicarPasse(passId, { cancelarSeFalhar: true, userId }, deps);
    if (!r.aplicado) {
      if (r.motivo === 'falha_asaas') {
        throw new SeatPassError(502, 'FALHA_ASAAS',
          'Não conseguimos ajustar a sua assinatura agora. Nada foi contratado nem será cobrado. Tente novamente em alguns minutos.');
      }
      throw new SeatPassError(409, 'ASSINATURA_INDISPONIVEL',
        'A assinatura não está ativa para receber o ajuste. Nada foi contratado nem será cobrado.');
    }
  }

  const { rows: linha } = await db.query(`SELECT ${PASS_COLS} FROM seat_passes WHERE id = $1`, [passId]);
  const passe = formatarPasse(linha[0]);
  return {
    passe,
    cobranca: passe.cobranca,
    // Contratou antes de 01/11: nada muda hoje; os assentos entram sozinhos na data.
    comeca_em: passe.starts_at,
    aplicado_agora: passe.aplicado,
    mensagem: passe.agendado
      ? `Assento de temporada agendado: começa em ${temporada.dataBr(passe.starts_at)}. ${passe.cobranca.texto}`
      : passe.cobranca.texto,
  };
}

// ── Cancelar (dono) ──────────────────────────────────────────
async function cancelar({ companyId, passId, userId = null, source = 'loja' }, deps = {}) {
  const { db } = resolverDeps(deps);
  const company = await carregarEmpresa(db, companyId);
  if (!company) throw new SeatPassError(404, 'EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');

  let r;
  try {
    r = await encerrarPasse(passId, {
      status: 'cancelado',
      motivo: source === 'admin' ? 'cancelado_admin' : 'cancelado_loja',
      companyId: company.id,
      userId,
    }, deps);
  } catch (err) {
    if (tabelaAusente(err)) throw migrationPendente();
    throw err;
  }
  if (!r.encerrado) {
    throw new SeatPassError(404, 'PASSE_NAO_ENCONTRADO', 'Assento de temporada não encontrado ou já encerrado');
  }

  return {
    cancelado: true,
    assentos_removidos: r.assentosRemovidos,
    mensagem: r.assentosRemovidos > 0
      ? 'Assento de temporada cancelado. O valor da assinatura volta ao normal a partir das próximas mensalidades; mensalidades já emitidas não são reembolsadas.'
      : 'Assento de temporada cancelado antes de começar. Nada será cobrado.',
    sync_pendente: !!r.sync_pendente,
  };
}

// ── Rodada diaria (chamada pelo jobs/seatPassScheduler.js) ───
/**
 * 1. expira os passes vencidos (ends_at < hoje) e tira os assentos;
 * 2. aplica os que chegaram na data de inicio (contratados antes de 01/11);
 * 3. refaz o valor das assinaturas que ficaram com sync_pendente.
 * Cada passe e' isolado: um erro vira entrada em `erros`, nao derruba a rodada.
 */
async function rodarDiario(deps = {}) {
  const { db, hoje, sync } = resolverDeps(deps);
  const lote = deps.lote || 200;
  const resumo = { hoje, expirados: 0, aplicados: 0, cancelados: 0, ressincronizados: 0, erros: [] };

  // 1. Expirar
  const { rows: vencidos } = await db.query(
    `SELECT id FROM seat_passes WHERE status = 'ativo' AND ends_at < $1::date ORDER BY ends_at LIMIT $2`,
    [hoje, lote]
  );
  for (const { id } of vencidos) {
    try {
      const r = await encerrarPasse(id, { status: 'expirado', motivo: 'fim_da_temporada' }, deps);
      if (r.encerrado) resumo.expirados++;
      if (r.sync_pendente) resumo.erros.push({ pass_id: id, etapa: 'expirar', erro: 'ajuste na Asaas pendente' });
    } catch (err) {
      resumo.erros.push({ pass_id: id, etapa: 'expirar', erro: err.message });
    }
  }

  // 2. Aplicar os que comecam
  const { rows: comecando } = await db.query(
    `SELECT id FROM seat_passes
      WHERE status = 'ativo' AND applied_at IS NULL
        AND starts_at <= $1::date AND ends_at >= $1::date
      ORDER BY starts_at LIMIT $2`,
    [hoje, lote]
  );
  for (const { id } of comecando) {
    try {
      const r = await aplicarPasse(id, { cancelarSeFalhar: false }, deps);
      if (r.aplicado) resumo.aplicados++;
      else if (r.cancelado) resumo.cancelados++;
      else if (r.motivo === 'falha_asaas') resumo.erros.push({ pass_id: id, etapa: 'aplicar', erro: 'Asaas indisponível; tenta de novo' });
    } catch (err) {
      resumo.erros.push({ pass_id: id, etapa: 'aplicar', erro: err.message });
    }
  }

  // 3. Ajustes que ficaram para tras
  const { rows: pendentes } = await db.query(
    `SELECT id, company_id FROM seat_passes WHERE sync_pendente ORDER BY created_at LIMIT $1`,
    [lote]
  );
  for (const { id, company_id: cid } of pendentes) {
    try {
      const { rows: emp } = await db.query(
        `SELECT id, plan, billing_cycle, billing_status, asaas_subscription_id,
                COALESCE(extra_seats_granted, 0) AS extra_seats_granted
           FROM companies WHERE id = $1`,
        [cid]
      );
      if (!emp.length) { await marcarSyncPendente(db, id, false); continue; }
      const resultado = await sync(empresaDaLinha(emp[0]));
      if (classificarSync(resultado) !== 'transitorio') {
        await marcarSyncPendente(db, id, false);
        resumo.ressincronizados++;
        await auditar(db, {
          companyId: cid, action: 'seat_pass.resynced',
          detail: 'Valor da assinatura refeito (ajuste que estava pendente)',
          metadata: { pass_id: id, sync: resultado.updated ? 'ajustado' : resultado.skipped, valor_assinatura: resultado.value },
        });
      } else {
        resumo.erros.push({ pass_id: id, etapa: 'ressincronizar', erro: resultado.error || resultado.skipped });
      }
    } catch (err) {
      resumo.erros.push({ pass_id: id, etapa: 'ressincronizar', erro: err.message });
    }
  }

  return resumo;
}

module.exports = {
  SeatPassError,
  enviarErro,
  estado,
  contratar,
  cancelar,
  aplicarPasse,
  encerrarPasse,
  rodarDiario,
  classificarSync,
  motivoSemCobranca,
  formatarPasse,
};
