// ============================================================
// AURA. — NF-e modelo 55 de VENDA (emissão própria, SEFAZ direto)
// Mounted at: /companies/:id/nfe55   — 14/11/2026, CP2b.
//
//   GET  /venda/:saleId/previa   destinatário pré-preenchido, itens com
//   POST /venda/:saleId/previa   CFOP sugerido, totais e faltantes (o
//                                wizard usa nos passos 1-3, sem emitir;
//                                o POST aceita o mesmo corpo do emitir)
//   POST /venda/:saleId/emitir   emite (contrato no PR / services/nfe55Venda)
//
// Por que um router próprio e não o /nfce/emit: o /emit é a esteira do PDV
// (contingência offline, fallback de gateway, homologação "stub", corpo com
// os itens do app, regra de ouro byte a byte com fixtures). A 55 de venda
// tem outro contrato — nasce SEMPRE da venda gravada, tem destinatário
// completo, faltantes para o wizard e nenhuma contingência. Encaixar lá
// misturaria os dois fluxos; aqui o /nfce/emit fica intocado, exceto pela
// trava "uma nota de produtos por venda" (que vale nos dois sentidos).
//
// Gravação: nfce_emissions com tipo='nfe' e finalidade=1. É o que o app
// já lê como "NF-e" (tipo === 'nfe' no rótulo da lista, do cancelamento e
// do resumo total_nfe do GET /nfce). A devolução também é tipo='nfe', mas
// finalidade=4 e sale_id da TROCA — nunca colide com a venda.
//
// Numeração: o MESMO contador da 55 de devolução (nfce_config.serie_nfe55 /
// next_number_nfe55, migration 278): mesmo modelo + mesma série = mesma
// sequência na SEFAZ. Timeout ambíguo nunca renumera: a tentativa seguinte
// consulta a chave antes e, se não consta, reenvia o MESMO número e cNF.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');
const nfe55Venda = require('../services/nfe55Venda');
const engine = require('../services/sefazSp/nfe55Venda');
const rejectionCatalog = require('../services/sefazSp/rejectionCatalog');
const { extrairProtNFe } = require('../services/sefazSp/nfeProc');

const MSG_FALTANTES = 'Faltam alguns dados para emitir a NF-e. Confira os campos marcados e tente de novo.';
// Rejeição por número já usado: o número está queimado, a próxima tentativa
// pega um número novo (as demais rejeições reaproveitam o número).
const CSTAT_NUMERO_QUEIMADO = new Set(['204', '206', '539']);

function semXml(row) {
  if (!row) return row;
  const { xml_signed, ...resto } = row; // eslint-disable-line no-unused-vars
  return resto;
}

function resumoNota(row) {
  return row ? {
    id: row.id, tipo: row.tipo, numero: row.numero, serie: row.serie,
    status: row.status, chave_acesso: row.chave_acesso || null,
  } : null;
}

/**
 * Decide o que fazer com as notas que a venda já tem.
 * @returns {{ conflito?: row, pendente?: row, anterior?: row }}
 *   conflito  → 409 (já tem nota de produtos)
 *   pendente  → 55 em 'processando' (timeout ambíguo): consultar antes
 *   anterior  → última 55 rejeitada/erro (reaproveita número)
 */
function avaliarNotas(rows) {
  const nfce = rows.find((r) => r.tipo === 'nfce' && nfe55Venda.STATUS_QUE_TRAVAM.includes(r.status));
  if (nfce) return { conflito: nfce };
  const nfe = rows.filter((r) => r.tipo === 'nfe');
  const fechada = nfe.find((r) => ['autorizada', 'denegada', 'contingencia'].includes(r.status));
  if (fechada) return { conflito: fechada };
  const pendente = nfe.find((r) => r.status === 'processando');
  if (pendente) return { pendente };
  const anterior = nfe.find((r) => ['rejeitada', 'erro'].includes(r.status) && r.numero != null) || null;
  return { anterior };
}

function respostaConflito(res, row) {
  const ehNfe = row.tipo === 'nfe';
  return res.status(409).json({
    error: ehNfe
      ? `Esta venda já tem a NF-e nº ${row.numero} (${row.status}). Cada venda tem uma nota de produtos só.`
      : `Esta venda já tem NFC-e (${row.status}). Cada venda tem uma nota de produtos só: para trocar por NF-e, cancele a NFC-e antes.`,
    code: 'NOTA_DE_PRODUTOS_JA_EXISTE',
    nota: resumoNota(row),
  });
}

async function montar(req) {
  return nfe55Venda.montarNotaDaVenda(db, {
    companyId: req.params.id, saleId: req.params.saleId, body: req.body || {},
  });
}

// ── Prévia ──────────────────────────────────────────────────

async function previa(req, res) {
  try {
    const rows = await nfe55Venda.notasDaVenda(db, req.params.id, req.params.saleId);
    const { conflito, pendente } = avaliarNotas(rows);
    const m = await montar(req);
    if (m.bloqueio && m.bloqueio.status === 404) {
      return res.status(404).json({ error: m.bloqueio.error, code: m.bloqueio.code });
    }
    let bloqueio = m.bloqueio ? { code: m.bloqueio.code, error: m.bloqueio.error } : null;
    if (!bloqueio) {
      const cert = await nfe55Venda.motivoCertificado(db, req.params.id);
      if (cert) bloqueio = { code: 'NFE_CERTIFICADO', error: cert };
    }
    const faltantes = m.faltantes || [];
    return res.json({
      pode_emitir: !bloqueio && !conflito && faltantes.length === 0,
      bloqueio,
      faltantes,
      nota_existente: conflito ? resumoNota(conflito) : null,
      nota_pendente: pendente ? resumoNota(pendente) : null,
      ...(m.previa || {}),
    });
  } catch (err) {
    console.error('[nfe55Venda] previa error:', err);
    return res.status(500).json({ error: 'Erro ao montar a prévia da NF-e' });
  }
}

router.get('/venda/:saleId/previa', requireAuth, previa);
router.post('/venda/:saleId/previa', requireAuth, previa);

// ── Emissão ─────────────────────────────────────────────────

async function gravarAntesDoEnvio(emissionId, chave, xmlSigned) {
  try {
    await db.query(
      'UPDATE nfce_emissions SET chave_acesso = $1, xml_signed = $2 WHERE id = $3',
      [chave, xmlSigned, emissionId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
    await db.query('UPDATE nfce_emissions SET chave_acesso = $1 WHERE id = $2', [chave, emissionId]);
  }
}

async function gravarResultado(emissionId, r) {
  const { status, protocolo, cStat, motivo } = r;
  const erro = status === 'rejeitada' ? `[${cStat || '?'}] ${motivo || 'Rejeitada pela SEFAZ'}`
    : (status === 'erro' || status === 'processando') ? (motivo || null) : null;
  await db.query(
    `UPDATE nfce_emissions
        SET status = $1, protocolo = COALESCE($2, protocolo),
            authorized_at = CASE WHEN $5 THEN NOW() ELSE authorized_at END,
            error_message = $3
      WHERE id = $4`,
    [status, protocolo || null, erro, emissionId, status === 'autorizada']
  );
  // Colunas da emissão própria (234/237): defensivo, nunca derruba a emissão.
  try {
    await db.query(
      `UPDATE nfce_emissions
          SET rejection_code = $1, tp_emis = 1, provider_used = 'sefaz_sp',
              transmitted_at = CASE WHEN $2 THEN NOW() ELSE transmitted_at END
        WHERE id = $3`,
      [status === 'rejeitada' ? (String(cStat || '').slice(0, 8) || null) : null, status === 'autorizada', emissionId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
  }
  // CP3: o <protNFe> da SEFAZ fica no metadata (vira o nfeProc do XML/e-mail).
  if (r.protXml) {
    try {
      await db.query(
        `UPDATE nfce_emissions
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('prot_xml', $1::text)
          WHERE id = $2`,
        [r.protXml, emissionId]
      );
    } catch (e) {
      if (e.code !== '42703') throw e;
    }
  }
}

async function reservarNumero(companyId) {
  try {
    const { rows } = await db.query(
      `UPDATE nfce_config
          SET next_number_nfe55 = next_number_nfe55 + 1, updated_at = NOW()
        WHERE company_id = $1
        RETURNING serie_nfe55, next_number_nfe55 - 1 AS numero`,
      [companyId]
    );
    if (!rows.length) return null;
    return { serie: parseInt(rows[0].serie_nfe55, 10) || 2, numero: parseInt(rows[0].numero, 10) || 1 };
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null; // migration 278 ausente
    throw e;
  }
}

function cnfDaChave(chave, { serie, numero }) {
  const c = String(chave || '');
  if (!/^\d{44}$/.test(c) || c.slice(20, 22) !== '55') return undefined;
  if (Number(c.slice(22, 25)) !== Number(serie) || Number(c.slice(25, 34)) !== Number(numero)) return undefined;
  return c.slice(35, 43);
}

function formaResumo(payments) {
  const formas = [...new Set((payments || []).map((p) => p.forma || p.method))];
  return (formas.length > 1 ? 'multiplo' : (formas[0] || 'outros')).slice(0, 30);
}

router.post('/venda/:saleId/emitir', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.saleId;
  const body = req.body || {};
  try {
    // 1. Uma nota de produtos por venda.
    const rows = await nfe55Venda.notasDaVenda(db, companyId, saleId);
    const { conflito, pendente, anterior } = avaliarNotas(rows);
    if (conflito) return respostaConflito(res, conflito);

    // 2. Dados da nota (venda gravada + cadastro + corpo).
    const m = await montar(req);
    if (m.bloqueio) {
      return res.status(m.bloqueio.status).json({
        error: m.bloqueio.error, code: m.bloqueio.code,
        ...(m.faltantes && m.faltantes.length ? { faltantes: m.faltantes } : {}),
      });
    }
    if (m.faltantes.length) {
      return res.status(422).json({ error: MSG_FALTANTES, code: 'NFE_DADOS_FALTANTES', faltantes: m.faltantes });
    }
    const certMotivo = await nfe55Venda.motivoCertificado(db, companyId);
    if (certMotivo) return res.status(422).json({ error: certMotivo, code: 'NFE_CERTIFICADO' });

    // 3. Salvar no cadastro (pedido do lojista). Nunca derruba a emissão.
    let cadastro = null;
    if (body.salvar_no_cadastro === true) {
      try {
        cadastro = await nfe55Venda.salvarNoCadastro(db, companyId, m.venda.customer_id, {
          documento: m.previa.destinatario.documento, nome: m.previa.destinatario.nome,
          email: m.previa.destinatario.email, ie: m.previa.destinatario.ie,
          indIEDest: String(m.previa.destinatario.ind_ie_dest),
          endereco: m.previa.destinatario.endereco,
        });
      } catch (e) {
        console.error('[nfe55Venda] salvar no cadastro falhou:', e.message);
        cadastro = { salvo: false, motivo: 'erro' };
      }
    }

    const ctxEngine = { db, config: m.config };

    // 4. Tentativa anterior em 'processando' (timeout ambíguo): consulta a
    //    chave ANTES de qualquer reenvio. Nunca renumera.
    let emission = null;
    let numeracao = null;
    let cNF;
    if (pendente) {
      const temChave = /^\d{44}$/.test(String(pendente.chave_acesso || ''));
      if (temChave) {
        let consulta;
        try {
          consulta = await engine.consultarNfe55({
            db, config: m.config, companyId, chave: pendente.chave_acesso,
          });
        } catch (e) {
          return res.status(503).json({
            error: 'A SEFAZ ainda não respondeu sobre a tentativa anterior desta NF-e. Tente de novo em instantes '
              + '(o número e a chave continuam os mesmos).',
            code: 'NFE_SEFAZ_SEM_RESPOSTA', nota: resumoNota(pendente),
          });
        }
        if (consulta.autorizada) {
          await gravarResultado(pendente.id, {
            status: 'autorizada', protocolo: consulta.protocolo, cStat: consulta.cStat,
            protXml: extrairProtNFe(consulta.rawXml),
          });
          const { rows: fin } = await db.query('SELECT * FROM nfce_emissions WHERE id = $1', [pendente.id]);
          logAuditAction(req.user.id, companyId, 'nfe55_venda_emitida',
            `NF-e nº ${pendente.numero} de venda autorizada (recuperada após timeout)`, { sale_id: saleId });
          return res.status(201).json({
            nfe: semXml(fin[0]), status: 'autorizada', recuperada: true,
            chave_acesso: pendente.chave_acesso, protocolo: consulta.protocolo || null,
            numero: pendente.numero, serie: pendente.serie, ambiente: m.previa.ambiente,
            ...(cadastro ? { cadastro } : {}),
          });
        }
        if (!consulta.naoConsta) {
          return res.status(502).json({
            error: `A SEFAZ respondeu algo inesperado sobre a tentativa anterior (cStat ${consulta.cStat}). Fale com o suporte antes de emitir de novo.`,
            code: 'NFE_SITUACAO_INESPERADA', nota: resumoNota(pendente), cStat: consulta.cStat,
          });
        }
      }
      // Não consta (ou nem chegou a ter chave): reenvia com o MESMO número.
      emission = pendente;
      numeracao = { serie: pendente.serie, numero: pendente.numero };
      cNF = cnfDaChave(pendente.chave_acesso, numeracao);
    } else if (anterior) {
      const cStatAnt = String(anterior.rejection_code || rejectionCatalog.cStatFromErrorMessage(anterior.error_message) || '');
      const queimado = anterior.status === 'rejeitada' && CSTAT_NUMERO_QUEIMADO.has(cStatAnt);
      if (!queimado) {
        numeracao = { serie: anterior.serie, numero: anterior.numero };
        cNF = cnfDaChave(anterior.chave_acesso, numeracao);
      }
    }

    // 5. Número (mesmo contador da devolução 55).
    if (!numeracao) {
      numeracao = await reservarNumero(companyId);
      if (!numeracao) {
        return res.status(422).json({ error: nfe55Venda.MSG.numeracao, code: 'NFE55_NUMERACAO_INDISPONIVEL' });
      }
    }

    const nfeData = { ...m.nfeData, serie: numeracao.serie, numero: numeracao.numero };
    const totais = m.previa.totais;
    const metadata = {
      nfe55_venda: {
        id_dest: m.previa.operacao.id_dest, ind_final: m.previa.operacao.ind_final,
        ind_ie_dest: m.previa.operacao.ind_ie_dest, natureza_operacao: m.previa.operacao.natureza_operacao,
        frete: m.previa.frete, pagamentos: m.previa.pagamentos, totais,
      },
    };

    if (emission) {
      await db.query(
        `UPDATE nfce_emissions SET status = 'processando', error_message = NULL WHERE id = $1`,
        [emission.id]
      );
    } else {
      const vals = [
        companyId, saleId, numeracao.numero, numeracao.serie,
        m.previa.destinatario.documento, String(m.previa.destinatario.nome || '').slice(0, 200),
        JSON.stringify(nfeData.items), totais.produtos, totais.desconto, totais.nota,
        formaResumo(m.previa.pagamentos), req.user.id,
      ];
      let created;
      try {
        ({ rows: created } = await db.query(
          `INSERT INTO nfce_emissions
             (company_id, sale_id, numero, serie, chave_acesso, tipo, finalidade, status,
              customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
              payment_method, emitted_by, metadata)
           VALUES ($1, $2, $3, $4, NULL, 'nfe', 1, 'processando', $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
           RETURNING *`,
          vals.concat([JSON.stringify(metadata)])
        ));
      } catch (e) {
        if (e.code !== '42703') throw e;
        ({ rows: created } = await db.query(
          `INSERT INTO nfce_emissions
             (company_id, sale_id, numero, serie, chave_acesso, tipo, status,
              customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
              payment_method, emitted_by)
           VALUES ($1, $2, $3, $4, NULL, 'nfe', 'processando', $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
           RETURNING *`,
          vals
        ));
      }
      emission = created[0];
    }

    // 6. Transmite. A chave real e o XML vão para o banco ANTES do envio.
    let r;
    try {
      r = await engine.emitNfeVenda55(m.company, nfeData, {
        ...ctxEngine, cNF,
        onBeforeTransmit: ({ chave, xml_signed }) => gravarAntesDoEnvio(emission.id, chave, xml_signed),
      });
    } catch (engErr) {
      console.error('[nfe55Venda] engine falhou:', engErr.message);
      await gravarResultado(emission.id, { status: 'erro', motivo: engErr.message });
      return res.status(502).json({
        error: 'Não foi possível emitir a NF-e agora: ' + engErr.message,
        code: 'NFE_ERRO_ENVIO', nfe_id: emission.id,
      });
    }

    const status = r.status === 'autorizado' ? 'autorizada'
      : r.status === 'rejeitado' ? 'rejeitada'
      : r.status === 'nao_consta' ? 'erro'
      : 'processando';
    await gravarResultado(emission.id, {
      status, protocolo: r.protocolo, cStat: r.codigo_status, motivo: r.motivo_status, protXml: r.prot_xml,
    });
    const { rows: fin } = await db.query('SELECT * FROM nfce_emissions WHERE id = $1', [emission.id]);
    const nota = semXml(fin[0] || { ...emission, status });

    logAuditAction(req.user.id, companyId, 'nfe55_venda_emitida',
      `NF-e nº ${numeracao.numero} de venda: ${status}${r.codigo_status ? ' (cStat ' + r.codigo_status + ')' : ''} -- R$ ${totais.nota}`,
      { sale_id: saleId, status });

    const comum = {
      nfe: nota, status, chave_acesso: r.chave_acesso, protocolo: r.protocolo || null,
      numero: numeracao.numero, serie: numeracao.serie, cStat: r.codigo_status || null,
      motivo: r.motivo_status || null, ambiente: m.previa.ambiente,
      ...(cadastro ? { cadastro } : {}),
    };
    if (status === 'autorizada') return res.status(201).json(comum);
    if (status === 'rejeitada') {
      return res.status(422).json({
        ...comum, code: 'NFE_REJEITADA',
        error: 'A SEFAZ recusou a NF-e. Veja o motivo, corrija e emita de novo.',
        rejeicao_amigavel: rejectionCatalog.lookup(r.codigo_status, r.motivo_status),
      });
    }
    return res.status(202).json({
      ...comum, code: 'NFE_AGUARDANDO_SEFAZ',
      error: r.motivo_status || 'A SEFAZ não respondeu a tempo. Tente de novo em instantes.',
    });
  } catch (err) {
    console.error('[nfe55Venda] emitir error:', err);
    return res.status(500).json({ error: 'Erro ao emitir a NF-e' });
  }
});

module.exports = router;
module.exports._avaliarNotas = avaliarNotas;
module.exports._cnfDaChave = cnfDaChave;
