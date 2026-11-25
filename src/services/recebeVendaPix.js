// ============================================================
// AURA. — Recebe na Aura: Pix do Caixa com confirmação (RA-10, 25/11/2026)
//
// A venda é gravada como sempre (POST /pdv/sale, forma 'pix'). Depois, o
// Caixa pede o "Pix pelo Recebe" DAQUELA venda: a cobrança Pix nasce na
// subconta da loja (recebeCobrancaService.createCharge, com o split da Aura
// e origin = { type: 'venda', id: <sale_id> } → externalReference
// recebe:venda:<sale_id>) e o QR volta para a tela. O Pix da venda fica
// AGUARDANDO até o aviso da Asaas (PAYMENT_RECEIVED / PAYMENT_CONFIRMED)
// chegar pelo webhook do Recebe, que o marca CONFIRMADO uma vez só.
//
// Estado em recebe_venda_pix (migration 466). Nada muda em sales,
// sale_payments nem no Financeiro: o valor da cobrança é a parte Pix da
// venda (sale_payments.method = 'pix').
//
// Quem paga, na Asaas (a cobrança exige nome + CPF/CNPJ):
//   1. body.customer { name, cpf_cnpj } (ex.: "CPF na nota");
//   2. a cliente da venda, se tiver CPF/CNPJ no cadastro;
//   3. senão, "Consumidor no Caixa" com o documento do titular da subconta
//      (kyc_snapshot). É só o registro do pagador na Asaas; quem paga de
//      verdade é quem lê o QR. Notificação da Asaas sempre desligada.
//
// Regras:
//   - flag RECEBE_NA_AURA_ENABLED desligada: nada aqui toca banco nem Asaas
//     (404, e a disponibilidade diz não). O Caixa segue com o Pix de hoje.
//   - só subconta APROVADA cria cobrança (a do createCharge). Qualquer
//     recusa do serviço volta com o código dele; o app cai no Pix de hoje.
//   - clique duplo: a linha é RESERVADA ('criando', índice único parcial de
//     uma cobrança viva por venda) antes de chamar a Asaas; só quem reservou
//     cria. Se a Asaas falhar, a reserva sai e a nova tentativa é segura
//     (createCharge procura antes pela externalReference).
//   - aviso repetido: o webhook já é idempotente pelo id do evento; aqui o
//     UPDATE só confirma de 'aguardando' (PAYMENT_CONFIRMED e depois
//     PAYMENT_RECEIVED do mesmo pagamento confirmam uma vez).
//   - desistência: cancela a cobrança na Asaas e marca 'cancelado'; a venda
//     NÃO é confirmada nem cancelada (a lojista troca a forma ou cancela a
//     venda, como hoje). Se a Asaas disser que já foi paga, confirma.
//   - a Aura NUNCA move dinheiro. Pix que cai depois de cancelar a cobrança,
//     ou com a venda cancelada, ou venda cancelada depois do Pix pago: nada é
//     estornado sozinho; a linha ganha `atencao` para a lojista resolver.
//
// Multi-CNPJ: tudo pela company_id da venda (a da URL, já conferida pelo
// requireCompanyAccess); o aviso só mexe em linha da empresa dona da subconta.
// Nunca loga chave, token, CPF/CNPJ nem corpo da Asaas.
// ============================================================
'use strict';

const db = require('../config/database');
const companyBaas = require('./companyBaasService');
const cobranca = require('./recebeCobrancaService');
const aviso = require('./recebeAviso');
const { svcError, str } = require('./baasShared');

const NOME = companyBaas.RECEBE_NA_AURA_NAME;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^recebe:venda:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// Reserva 'criando' parada há mais que isso = a chamada anterior morreu no meio.
const RESERVA_PARADA_MS = 2 * 60 * 1000;
const CONSUMIDOR_NO_CAIXA = 'Consumidor no Caixa';

const EVENTOS_PAGO = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];
const EVENTOS_ESTORNO = ['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'];

const ATENCAO_TEXTO = {
  pago_depois_de_cancelar:
    'O Pix desta venda caiu depois de a cobrança ser cancelada. O valor está na conta do Recebe na Aura da loja. ' +
    'A Aura não devolve nada sozinha: combine com a cliente e, se precisar de ajuda para devolver, fale com a equipe da Aura.',
  pago_com_venda_cancelada:
    'O Pix caiu, mas esta venda já estava cancelada. O valor está na conta do Recebe na Aura da loja. ' +
    'A Aura não devolve nada sozinha: combine com a cliente e, se precisar de ajuda para devolver, fale com a equipe da Aura.',
  venda_cancelada_com_pix_pago:
    'A venda foi cancelada depois de o Pix ser pago. O valor continua na conta do Recebe na Aura da loja. ' +
    'A Aura não devolve nada sozinha: combine com a cliente e, se precisar de ajuda para devolver, fale com a equipe da Aura.',
  estornado: 'A Asaas avisou um estorno ou uma contestação deste Pix. Confira com a equipe da Aura.',
};

function indisponivel() {
  return svcError(404, 'RECEBE_INDISPONIVEL', `O ${NOME} ainda não está disponível.`);
}

function schemaPendente() {
  return svcError(503, 'SCHEMA_PENDING', `O Pix pelo ${NOME} ainda não está disponível (migration 466 pendente).`);
}

function comExtra(e, extra) {
  e.extra = extra;
  return e;
}

function toCents(v) {
  return Math.round(Number(v) * 100);
}

function num(v) {
  return v == null ? null : Math.round(Number(v) * 100) / 100;
}

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Erro de tabela ausente vira 503 (migration 466 pendente).
async function q(sql, params) {
  try {
    return await db.query(sql, params);
  } catch (e) {
    if (e && e.code === '42P01') throw schemaPendente();
    throw e;
  }
}

// O que o app recebe. Nunca chave, token nem documento do pagador.
function shape(row, saleId, pix) {
  if (!row) {
    return {
      product_name: NOME, sale_id: saleId, status: 'nenhum', payment_id: null, value: null,
      aura_fee: null, pix: null, confirmed_at: null, cancelled_at: null,
      atencao: null, atencao_texto: null, created_at: null,
    };
  }
  const payload = (pix && pix.payload) || row.pix_payload || null;
  return {
    product_name: NOME,
    sale_id: row.sale_id,
    status: row.status,
    payment_id: row.asaas_payment_id || null,
    value: num(row.value),
    aura_fee: num(row.aura_fee),
    pix: payload && ['aguardando', 'criando'].includes(row.status) ? {
      payload,
      encoded_image: (pix && pix.encoded_image) || null,
      expiration_date: (pix && pix.expiration_date) || row.pix_expires_at || null,
    } : null,
    confirmed_at: iso(row.confirmed_at),
    cancelled_at: iso(row.cancelled_at),
    atencao: row.atencao || null,
    atencao_texto: row.atencao ? (ATENCAO_TEXTO[row.atencao] || null) : null,
    created_at: iso(row.created_at),
  };
}

const ROW_COLS = `id, company_id, sale_id, status, asaas_payment_id, external_reference, value, aura_fee,
  pix_payload, pix_expires_at, confirmed_at, cancelled_at, atencao, created_at`;

// Linha viva (criando/aguardando/confirmado) da venda; senão a mais recente.
async function loadRow(companyId, saleId) {
  const { rows } = await q(
    `SELECT ${ROW_COLS} FROM recebe_venda_pix
      WHERE company_id = $1 AND sale_id = $2
      ORDER BY (status IN ('criando', 'aguardando', 'confirmado')) DESC, created_at DESC
      LIMIT 1`,
    [companyId, saleId]
  );
  return rows[0] || null;
}

function assertIds(companyId, saleId) {
  if (!UUID_RE.test(str(companyId))) throw svcError(422, 'VALIDATION_ERROR', 'company_id deve ser um UUID');
  if (!UUID_RE.test(str(saleId))) throw svcError(422, 'VALIDATION_ERROR', 'O id da venda deve ser um UUID');
}

// ── O Caixa pode oferecer o Pix pelo Recebe? ──
// Nunca lança por regra de negócio: { disponivel, motivo }. Flag desligada:
// não toca banco.
async function disponibilidade(companyId) {
  if (!companyBaas.isEnabled()) return { disponivel: false, motivo: 'indisponivel' };
  if (!str(process.env[cobranca.WALLET_ENV])) return { disponivel: false, motivo: 'split_nao_configurado' };
  if (!aviso.resolveSecret().ok) return { disponivel: false, motivo: 'aviso_nao_configurado' };
  let row;
  try {
    const { rows } = await db.query(
      `SELECT status, (api_key_enc IS NOT NULL) AS tem_chave FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    row = rows[0] || null;
  } catch (e) {
    if (e && e.code === '42P01') return { disponivel: false, motivo: 'sem_subconta' };
    throw e;
  }
  if (!row) return { disponivel: false, motivo: 'sem_subconta' };
  if (row.status !== 'approved') return { disponivel: false, motivo: 'conta_nao_aprovada' };
  if (!row.tem_chave) return { disponivel: false, motivo: 'em_conferencia' };
  // Sem a 466, não há onde guardar o estado: não oferece.
  try {
    await db.query(`SELECT 1 FROM recebe_venda_pix LIMIT 0`);
  } catch (e) {
    if (e && e.code === '42P01') return { disponivel: false, motivo: 'schema_pendente' };
    throw e;
  }
  return { disponivel: true, motivo: null };
}

// Quem fica como pagador da cobrança na Asaas (ver cabeçalho).
async function resolvePagador(companyId, sale, body) {
  const c = (body && body.customer) || null;
  if (c && (str(c.cpf_cnpj) || str(c.name))) {
    return { name: str(c.name) || CONSUMIDOR_NO_CAIXA, cpf_cnpj: str(c.cpf_cnpj) };
  }
  if (sale.customer_id) {
    const { rows } = await db.query(`SELECT name, cpf_cnpj FROM customers WHERE id = $1 LIMIT 1`, [sale.customer_id]);
    const cli = rows[0];
    const doc = cli ? str(cli.cpf_cnpj).replace(/\D/g, '') : '';
    if (cli && (doc.length === 11 || doc.length === 14)) {
      return { name: str(cli.name) || CONSUMIDOR_NO_CAIXA, cpf_cnpj: doc };
    }
  }
  const { rows } = await db.query(
    `SELECT kyc_snapshot FROM company_baas_accounts WHERE company_id = $1 LIMIT 1`, [companyId]
  );
  let kyc = rows[0] && rows[0].kyc_snapshot;
  if (typeof kyc === 'string') { try { kyc = JSON.parse(kyc); } catch (_) { kyc = null; } }
  const doc = kyc ? str(kyc.cpf_cnpj).replace(/\D/g, '') : '';
  if (doc.length !== 11 && doc.length !== 14) {
    throw svcError(422, 'RECEBE_PIX_PEDE_CPF', 'Para gerar o Pix, informe o CPF ou CNPJ de quem está pagando.');
  }
  return { name: CONSUMIDOR_NO_CAIXA, cpf_cnpj: doc };
}

async function loadSale(companyId, saleId) {
  const { rows } = await db.query(
    `SELECT s.id, s.status, s.customer_id,
            (SELECT COALESCE(SUM(sp.amount), 0) FROM sale_payments sp
              WHERE sp.sale_id = s.id AND lower(sp.method) = 'pix') AS pix_amount
       FROM sales s
      WHERE s.id = $1 AND s.company_id = $2`,
    [saleId, companyId]
  );
  const sale = rows[0];
  if (!sale) throw svcError(404, 'VENDA_NAO_ENCONTRADA', 'Venda não encontrada.');
  return sale;
}

// QR de novo para uma cobrança aguardando (o guardado serve se a Asaas falhar).
async function qrDe(companyId, row) {
  try {
    return await cobranca.getPixQrCode(companyId, row.asaas_payment_id);
  } catch (e) {
    console.warn(`[recebeVendaPix] QR de novo indisponível (${e && e.code ? e.code : 'erro'})`);
    return null;
  }
}

// ── POST: cria (ou devolve) o Pix pelo Recebe da venda ──
async function criar(companyId, saleId, body, userId) {
  if (!companyBaas.isEnabled()) throw indisponivel();
  assertIds(companyId, saleId);

  const sale = await loadSale(companyId, saleId);
  if (sale.status === 'cancelled') throw svcError(409, 'VENDA_CANCELADA', 'Esta venda foi cancelada.');
  const valor = num(sale.pix_amount) || 0;
  if (valor <= 0) throw svcError(422, 'VENDA_SEM_PIX', 'Esta venda não tem parte em Pix.');

  // Já existe uma viva?
  let atual = await loadRow(companyId, saleId);
  if (atual && atual.status === 'criando' && Date.now() - new Date(atual.created_at).getTime() > RESERVA_PARADA_MS) {
    await q(`DELETE FROM recebe_venda_pix WHERE id = $1 AND status = 'criando'`, [atual.id]);
    atual = null;
  }
  if (atual && atual.status === 'confirmado') {
    return { reused: true, ...shape(atual, saleId) };
  }
  if (atual && atual.status === 'criando') {
    throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'O Pix desta venda está sendo gerado. Um instante.');
  }
  if (atual && atual.status === 'aguardando') {
    if (toCents(atual.value) !== toCents(valor)) {
      throw comExtra(svcError(409, 'RECEBE_PIX_VALOR_MUDOU',
        'O valor em Pix desta venda mudou. Cancele o Pix gerado e gere de novo.'), { recebe_pix: shape(atual, saleId) });
    }
    return { reused: true, ...shape(atual, saleId, await qrDe(companyId, atual)) };
  }

  const pagador = await resolvePagador(companyId, sale, body);
  const externalReference = cobranca.buildExternalReference({ type: 'venda', id: saleId });

  // Reserva: só quem reservou chama a Asaas.
  const { rows: res } = await q(
    `INSERT INTO recebe_venda_pix (company_id, sale_id, status, external_reference, value, created_by)
     VALUES ($1, $2, 'criando', $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [companyId, saleId, externalReference, valor, UUID_RE.test(str(userId)) ? str(userId) : null]
  );
  const reserva = res[0];
  if (!reserva) throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'O Pix desta venda está sendo gerado. Um instante.');

  let out;
  try {
    out = await cobranca.createCharge(companyId, {
      billing_type: 'PIX',
      value: valor,
      origin: { type: 'venda', id: saleId },
      customer: pagador,
      description: `Venda no Caixa (${NOME})`,
    });
  } catch (e) {
    // Nada ficou preso: a nova tentativa procura pela externalReference antes de criar.
    await q(`DELETE FROM recebe_venda_pix WHERE id = $1 AND status = 'criando'`, [reserva.id]);
    throw e;
  }

  let row;
  try {
    const { rows } = await q(
      `UPDATE recebe_venda_pix
          SET status = 'aguardando', asaas_payment_id = $2, aura_fee = $3, pix_payload = $4,
              pix_expires_at = $5, updated_at = now()
        WHERE id = $1 AND status = 'criando'
        RETURNING ${ROW_COLS}`,
      [reserva.id, out.payment_id, out.aura_fee, out.pix ? out.pix.payload : null, out.pix ? out.pix.expiration_date : null]
    );
    row = rows[0];
  } catch (e) {
    if (e && e.code === '23505') {
      await q(`DELETE FROM recebe_venda_pix WHERE id = $1 AND status = 'criando'`, [reserva.id]);
      throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'O Pix desta venda está sendo gerado. Um instante.');
    }
    throw e;
  }
  if (!row) throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'O Pix desta venda está sendo gerado. Um instante.');
  return { reused: !!out.reused, ...shape(row, saleId, out.pix) };
}

// ── GET: situação (polling curto do app). Só o banco, nunca a Asaas. ──
async function consultar(companyId, saleId) {
  if (!companyBaas.isEnabled()) throw indisponivel();
  assertIds(companyId, saleId);
  return shape(await loadRow(companyId, saleId), saleId);
}

async function marcarConfirmado(rowId, eventId) {
  const { rows } = await q(
    `UPDATE recebe_venda_pix
        SET status = 'confirmado', confirmed_at = now(), confirmed_event_id = $2,
            atencao = CASE WHEN (SELECT s.status FROM sales s WHERE s.id = recebe_venda_pix.sale_id) = 'cancelled'
                           THEN 'pago_com_venda_cancelada' ELSE atencao END,
            atencao_at = CASE WHEN (SELECT s.status FROM sales s WHERE s.id = recebe_venda_pix.sale_id) = 'cancelled'
                              THEN now() ELSE atencao_at END,
            updated_at = now()
      WHERE id = $1 AND status = 'aguardando'
      RETURNING ${ROW_COLS}`,
    [rowId, eventId ? String(eventId).slice(0, 200) : null]
  );
  return rows[0] || null;
}

async function marcarAtencao(rowId, atencao, onlyStatus) {
  const { rows } = await q(
    `UPDATE recebe_venda_pix
        SET atencao = $2, atencao_at = now(), updated_at = now()
      WHERE id = $1 AND status = $3 AND (atencao IS NULL OR atencao <> $2)
      RETURNING ${ROW_COLS}`,
    [rowId, atencao, onlyStatus]
  );
  return rows[0] || null;
}

// ── DELETE: a lojista desistiu do Pix pelo Recebe ──
async function cancelar(companyId, saleId, userId) {
  if (!companyBaas.isEnabled()) throw indisponivel();
  assertIds(companyId, saleId);
  const row = await loadRow(companyId, saleId);
  if (!row) throw svcError(404, 'RECEBE_PIX_NAO_ENCONTRADO', 'Esta venda não tem Pix pelo Recebe.');
  if (row.status === 'cancelado') return shape(row, saleId);
  if (row.status === 'criando') {
    throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'O Pix desta venda está sendo gerado. Um instante.');
  }
  const jaPago = (r) => comExtra(
    svcError(409, 'RECEBE_PIX_JA_PAGO', 'Este Pix já foi pago. Nada foi cancelado.'), { recebe_pix: shape(r, saleId) }
  );
  if (row.status === 'confirmado') throw jaPago(row);

  const r = await cobranca.cancelCharge(companyId, row.asaas_payment_id);
  if (r.paid) {
    // A Asaas diz que já está paga: confirma (consulta autenticada à subconta).
    const conf = await marcarConfirmado(row.id, 'conferido_no_cancelamento');
    throw jaPago(conf || (await loadRow(companyId, saleId)));
  }
  const { rows } = await q(
    `UPDATE recebe_venda_pix
        SET status = 'cancelado', cancelled_at = now(), cancelled_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'aguardando'
      RETURNING ${ROW_COLS}`,
    [row.id, UUID_RE.test(str(userId)) ? str(userId) : null]
  );
  if (rows[0]) return shape(rows[0], saleId);
  // O aviso confirmou no meio do caminho.
  const agora = await loadRow(companyId, saleId);
  if (agora && agora.status === 'confirmado') throw jaPago(agora);
  return shape(agora, saleId);
}

// ── Depois do DELETE /pdv/sale/:saleId (venda cancelada) ──
// Flag desligada: null sem tocar o banco. Nunca estorna: Pix pago ganha
// atenção; Pix aguardando é cancelado na Asaas (a cliente não paga venda
// cancelada). Erros não derrubam o cancelamento da venda (quem chama engole).
async function depoisDeCancelarVenda(companyId, saleId, userId) {
  if (!companyBaas.isEnabled()) return null;
  let row;
  try {
    row = await loadRow(companyId, saleId);
  } catch (e) {
    if (e && e.code === 'SCHEMA_PENDING') return null;
    throw e;
  }
  if (!row || row.status === 'cancelado' || row.status === 'criando') return row ? shape(row, saleId) : null;
  if (row.status === 'confirmado') {
    const marcada = await marcarAtencao(row.id, 'venda_cancelada_com_pix_pago', 'confirmado');
    return shape(marcada || row, saleId);
  }
  try {
    return await cancelar(companyId, saleId, userId);
  } catch (e) {
    if (e && e.code === 'RECEBE_PIX_JA_PAGO') {
      const marcada = await marcarAtencao(row.id, 'venda_cancelada_com_pix_pago', 'confirmado');
      return shape(marcada || (await loadRow(companyId, saleId)), saleId);
    }
    // Asaas fora: fica aguardando; se a cliente pagar, o aviso marca atenção.
    console.warn(`[recebeVendaPix] venda cancelada; não deu para cancelar o Pix na Asaas agora (${e && e.code ? e.code : 'erro'})`);
    return shape(row, saleId);
  }
}

// ── Aviso da Asaas (chamado pelo recebeWebhookService, já autenticado,
// idempotente pelo id do evento e com a empresa da subconta) ──
// Devolve { outcome, detail } no formato do webhook.
function vendaDaReferencia(ref) {
  const m = str(ref).match(REF_RE);
  return m ? m[1].toLowerCase() : null;
}

async function aplicarAviso(x, companyId) {
  const saleId = vendaDaReferencia(x.externalReference);
  if (!saleId) return { outcome: 'registered', detail: 'referencia_invalida' };
  if (!x.paymentId) return { outcome: 'registered', detail: 'sem_payment_id' };

  const { rows } = await q(
    `SELECT ${ROW_COLS} FROM recebe_venda_pix
      WHERE asaas_payment_id = $1 AND company_id = $2 AND sale_id = $3 LIMIT 1`,
    [x.paymentId, companyId, saleId]
  );
  const row = rows[0];
  const ev = str(x.event).toUpperCase();
  if (!row) {
    if (EVENTOS_PAGO.includes(ev)) {
      // Cobrança acabou de nascer e a linha ainda está em 'criando': o
      // reenvio da Asaas acha a linha pronta (500 aqui = retomada depois).
      const viva = await loadRow(companyId, saleId);
      if (viva && viva.status === 'criando') {
        throw svcError(409, 'RECEBE_PIX_EM_CRIACAO', 'cobrança da venda ainda em criação');
      }
    }
    return { outcome: 'registered', detail: 'venda_sem_cobranca_registrada' };
  }

  if (EVENTOS_PAGO.includes(ev)) {
    if (row.status === 'aguardando') {
      const conf = await marcarConfirmado(row.id, null);
      if (conf) return { outcome: 'processed', detail: conf.atencao ? `venda_confirmada ${conf.atencao}` : 'venda_confirmada' };
      return { outcome: 'registered', detail: 'ja_confirmado' };
    }
    if (row.status === 'confirmado') return { outcome: 'registered', detail: 'ja_confirmado' };
    if (row.status === 'cancelado') {
      const m = await marcarAtencao(row.id, 'pago_depois_de_cancelar', 'cancelado');
      return { outcome: m ? 'processed' : 'registered', detail: 'pago_depois_de_cancelar' };
    }
    return { outcome: 'registered', detail: `status=${row.status}` };
  }
  if (EVENTOS_ESTORNO.includes(ev)) {
    const m = await marcarAtencao(row.id, 'estornado', 'confirmado');
    return { outcome: m ? 'processed' : 'registered', detail: 'estornado' };
  }
  if (ev === 'PAYMENT_DELETED' && row.status === 'aguardando') {
    const { rows: c } = await q(
      `UPDATE recebe_venda_pix SET status = 'cancelado', cancelled_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'aguardando' RETURNING id`,
      [row.id]
    );
    return { outcome: c[0] ? 'processed' : 'registered', detail: 'cobranca_apagada_na_asaas' };
  }
  return { outcome: 'registered', detail: `venda ${ev || 'sem_evento'}` };
}

// ── Lista da loja: aguardando e o que pede atenção ──
async function listar(companyId, situacao) {
  if (!companyBaas.isEnabled()) throw indisponivel();
  if (!UUID_RE.test(str(companyId))) throw svcError(422, 'VALIDATION_ERROR', 'company_id deve ser um UUID');
  const s = str(situacao).toLowerCase();
  let where = `(status = 'aguardando' OR atencao IS NOT NULL)`;
  if (s === 'aguardando') where = `status = 'aguardando'`;
  else if (s === 'atencao') where = `atencao IS NOT NULL`;
  else if (s) throw svcError(422, 'VALIDATION_ERROR', 'situacao deve ser aguardando ou atencao');
  const { rows } = await q(
    `SELECT ${ROW_COLS} FROM recebe_venda_pix WHERE company_id = $1 AND ${where}
      ORDER BY created_at DESC LIMIT 100`,
    [companyId]
  );
  return { items: rows.map((r) => shape(r, r.sale_id)) };
}

module.exports = {
  ATENCAO_TEXTO,
  disponibilidade,
  criar,
  consultar,
  cancelar,
  depoisDeCancelarVenda,
  aplicarAviso,
  listar,
  // exportados p/ teste
  vendaDaReferencia,
  CONSUMIDOR_NO_CAIXA,
};
