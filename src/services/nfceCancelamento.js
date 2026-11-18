// ============================================================
// AURA. — Cancelar uma nota da venda (NFC-e 65 ou NF-e 55) — 17/11/2026
// Card b-troca-prazo-nfce.
//
// O corpo do POST /companies/:id/nfce/:nfceId/cancel (routes/nfce.js) veio
// para cá SEM mudar o caminho de cada nota, para o cancelar venda
// (routes/sales.js) usar o mesmo. A única mudança de regra: o prazo da NFC-e
// da emissão própria sai de services/nfcePrazoCancelamento.js (por UF), e o
// texto fora do prazo é o de services/textosPrazoNfce.js.
//
//   - emissão própria, modelo 55 → evento da 55 (nfe55Eventos, 24 h);
//   - emissão própria, NFC-e     → evento 110111 na SEFAZ ANTES de marcar;
//   - gateway / legado           → marca e avisa o gateway (como sempre).
//
// Devolve { status, body } — a rota responde com isso; o cancelar venda lê.
// ============================================================
'use strict';

const sefazSp = require('./sefazSp');
const eventos55 = require('./nfe55Eventos');
const nuvemfiscal = require('./nuvemfiscal');
const { logAuditAction } = require('../middleware/auditLog');
const { prazoDeCancelamento } = require('./nfcePrazoCancelamento');
const { TEXTOS_PRAZO_NFCE } = require('./textosPrazoNfce');

const MOTIVO_CURTO = 'Motivo do cancelamento exige ao menos 15 caracteres (regra SEFAZ)';

async function cancelarEmissao(db, { companyId, nfceId, reason, userId, now = Date.now(), env = process.env }) {
  if (!reason || String(reason).length < 15) return { status: 400, body: { error: MOTIVO_CURTO } };

  // S2.1: nota da emissão própria cancela via evento 110111 na SEFAZ
  // ANTES de marcar local — nada de cancelamento só-local.
  const { rows: ownRows } = await db.query(
    `SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2 AND xml_signed IS NOT NULL`,
    [nfceId, companyId]
  );
  if (ownRows.length) {
    const own = ownRows[0];
    if (own.status === 'cancelada') return { status: 200, body: { nfce: own, idempotent: true } };
    // 14/11/2026 (NF-e 55, CP5): a NF-e modelo 55 vai ao evento da 55.
    if (eventos55.ehModelo55(own.chave_acesso)) {
      try {
        const r = await eventos55.cancelarNfe55(db, own, { justificativa: reason, userId });
        logAuditAction(userId, companyId, 'nfe55_cancelada',
          `NF-e nº ${own.numero} cancelada na SEFAZ (evento ${r.evento.protocolo || r.evento.cStat}): ${reason}`);
        const { xml_signed, ...nota } = r.nota; // eslint-disable-line no-unused-vars
        return { status: 200, body: { nfce: nota, evento: { cStat: r.evento.cStat, protocolo: r.evento.protocolo, ja_cancelada: !!r.evento.ja_cancelada }, cancelavel_ate: r.prazo.ate } };
      } catch (e) {
        if (e && e.code && e.status) return { status: e.status, body: { error: e.message, code: e.code, ...(e.extra || {}) } };
        throw e;
      }
    }
    if (own.status !== 'autorizada') {
      return { status: 400, body: { error: `Nota não pode ser cancelada (status: ${own.status})` } };
    }
    const { rows: cfgRows } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [companyId]);
    // 17/11/2026: prazo por UF (UF da chave; senão a da configuração).
    const prazo = prazoDeCancelamento(own, { uf: cfgRows[0] && cfgRows[0].uf, now, env });
    if (prazo.vencido) {
      return {
        status: 400,
        body: {
          error: TEXTOS_PRAZO_NFCE.cancelarForaDoPrazo(prazo),
          code: 'NFCE_PRAZO_CANCELAMENTO_VENCIDO',
          caminho: 'devolucao',
          uf: prazo.uf, prazo_minutos: prazo.minutos, cancelavel_ate: prazo.ate,
        },
      };
    }
    if (!cfgRows.length) return { status: 400, body: { error: 'Config NFC-e não encontrada' } };
    try {
      const ev = await sefazSp.cancelNfce({
        db, config: cfgRows[0], companyId,
        chave: own.chave_acesso, protocolo: own.protocolo, justificativa: reason,
      });
      if (!ev.sucesso) {
        return { status: 422, body: { error: `SEFAZ recusou o cancelamento: [${ev.cStat}] ${ev.xMotivo || ''}`, cStat: ev.cStat } };
      }
      const { rows: upd } = await db.query(
        `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW() WHERE id=$2 RETURNING *`,
        [reason, own.id]
      );
      logAuditAction(userId, companyId, 'nfce_cancelled',
        `NFC-e no ${own.numero} cancelada na SEFAZ (evento ${ev.protocoloEvento || ev.cStat}): ${reason}`);
      return { status: 200, body: { nfce: upd[0], evento: { cStat: ev.cStat, protocolo: ev.protocoloEvento, ja_cancelada: ev.jaCancelada || false }, cancelavel_ate: prazo.ate } };
    } catch (apiErr) {
      console.error('[nfce] SEFAZ cancel error:', apiErr.message);
      return { status: 502, body: { error: 'Erro ao cancelar na SEFAZ: ' + apiErr.message } };
    }
  }

  // Gateway / legado: igual a antes.
  const { rows } = await db.query(
    `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW()
      WHERE id=$2 AND company_id=$3 AND status='autorizada' RETURNING *`,
    [reason, nfceId, companyId]
  );
  if (!rows.length) return { status: 400, body: { error: 'Nota nao encontrada ou nao pode ser cancelada' } };
  const emission = rows[0];
  if (emission.nuvemfiscal_id) {
    try {
      const cancelFn = emission.tipo === 'nfe' ? nuvemfiscal.cancelNfe : nuvemfiscal.cancelNfce;
      await cancelFn(emission.nuvemfiscal_id, reason);
    } catch (apiErr) {
      console.error('[nfce] Nuvem Fiscal cancel error:', apiErr.message);
      await db.query('UPDATE nfce_emissions SET error_message=$1 WHERE id=$2',
        ['Cancelamento local OK. Erro Nuvem Fiscal: ' + apiErr.message, emission.id]);
    }
  }
  logAuditAction(userId, companyId, 'nfce_cancelled', `${(emission.tipo || 'nfce').toUpperCase()} no ${emission.numero} cancelada: ${reason}`);
  return { status: 200, body: { nfce: emission } };
}

module.exports = { cancelarEmissao, MOTIVO_CURTO };
