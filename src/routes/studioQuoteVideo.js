// ============================================================
// AURA Studio · Orçamento em vídeo 3D pelo WhatsApp (28/09/2026)
// Montado em private.js sob /studio (mesmo gate de studioQuotes).
// Desenho: aura-app docs/studio/orcamento-video-3d.md
//
// PUT  /studio/quotes/:qid/condicoes      → condições da lojista (Pix, parcelas, prazo, obs, sinal, validade)
// PUT  /studio/quotes/:qid/video          → corpo BINÁRIO (video/mp4|webm, até 12 MB) → guarda 30 dias
// GET  /studio/quotes/:qid/video          → o arquivo (só para o painel autenticado)
// POST /studio/quotes/:qid/video/manter   → +30 dias
// POST /studio/quotes/:qid/marcar-enviado → draft|sent → sent, SEM token (não há página pública)
// POST /studio/quotes/:qid/fechar         → encerra sem venda (status 'closed')
// POST /studio/quotes/:qid/ajuste         → cliente pediu ajuste: registra e volta a draft (362)
//
// "Aprovar" (vira pedido) mora em studioQuotes.js, ao lado do convert.
//
// Multi-CNPJ: toda consulta filtra por id E company_id (o :id da rota é o
// CNPJ que emitiu o orçamento). Nada é lido de outra empresa do grupo.
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const r2      = require('../utils/r2Storage');
const regras  = require('../services/orcamentoEmVideo');

const LIMITE_DO_VIDEO = '12mb';

async function buscarOrcamento(qid, cid) {
  const r = await db.query(
    `SELECT * FROM studio_quotes WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [qid, cid]
  );
  return r.rows[0] || null;
}

function semColuna(err) {
  return err && (err.code === '42703' || err.code === '42P01');
}

/** O que o painel precisa saber do vídeo, sem a chave do R2. */
function resumoDoVideo(q) {
  if (!q || !q.video_key) return null;
  return {
    content_type: q.video_content_type || 'video/mp4',
    bytes: q.video_bytes != null ? Number(q.video_bytes) : null,
    formato: q.video_formato || null,
    gerado_em: q.video_gerado_em || null,
    expira_em: q.video_expira_em || null,
  };
}

// ─── PUT /quotes/:qid/condicoes ──────────────────────────────
router.put('/quotes/:qid/condicoes', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;
  const lidas = regras.lerCondicoes(req.body);
  if (!lidas.ok) return res.status(400).json({ error: lidas.erro });

  try {
    const q = await buscarOrcamento(qid, cid);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (!regras.STATUS_ABERTOS.includes(q.status)) {
      return res.status(400).json({ error: 'Só dá para mudar as condições de um orçamento em aberto' });
    }

    // Sinal e validade são colunas do orçamento desde a 138: continuam lá.
    const { deposit_pct, validity_days } = req.body || {};
    let depPct = q.deposit_pct != null ? Number(q.deposit_pct) : null;
    let depAmount = q.deposit_amount != null ? Number(q.deposit_amount) : null;
    if (deposit_pct !== undefined) {
      const p = deposit_pct === null || deposit_pct === '' ? null : Number(deposit_pct);
      if (p !== null && (!Number.isFinite(p) || p <= 0 || p > 100)) {
        return res.status(400).json({ error: 'Sinal deve ficar entre 1% e 100%' });
      }
      depPct = p;
      depAmount = p === null ? null : parseFloat(((Number(q.total) || 0) * p / 100).toFixed(2));
    }
    let vDays = q.validity_days;
    if (validity_days !== undefined && validity_days !== null && validity_days !== '') {
      const d = parseInt(validity_days, 10);
      if (!Number.isInteger(d) || d < 1 || d > 90) {
        return res.status(400).json({ error: 'Validade deve ficar entre 1 e 90 dias' });
      }
      vDays = d;
    }

    const upd = await db.query(
      `UPDATE studio_quotes
          SET condicoes      = $1,
              deposit_pct    = $2,
              deposit_amount = $3,
              validity_days  = $4,
              expires_at     = CASE WHEN status = 'sent' AND sent_at IS NOT NULL
                                    THEN sent_at + ($4 || ' days')::interval
                                    ELSE expires_at END,
              updated_at     = NOW()
        WHERE id = $5 AND company_id = $6
        RETURNING *`,
      [JSON.stringify(lidas.condicoes), depPct, depAmount, vDays, qid, cid]
    );
    const quote = upd.rows[0];
    res.json({ quote, valores: regras.valoresDasCondicoes(quote) });
  } catch (err) {
    if (semColuna(err)) return res.status(503).json({ error: 'Orçamento em vídeo ainda não está disponível' });
    console.error('[studio/quotes/:qid/condicoes]', err.message);
    res.status(500).json({ error: 'Erro ao salvar as condições' });
  }
});

// ─── PUT /quotes/:qid/video ──────────────────────────────────
// Binário e não base64: o express.json global é de 5 MB e o base64 incha
// um terço. O parser mora só nesta rota.
router.put(
  '/quotes/:qid/video',
  express.raw({ type: regras.TIPOS_DE_VIDEO, limit: LIMITE_DO_VIDEO }),
  async function(req, res) {
    const cid = req.params.id;
    const qid = req.params.qid;
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

    if (!regras.TIPOS_DE_VIDEO.includes(contentType)) {
      return res.status(415).json({ error: 'Vídeo deve ser MP4 ou WebM', allowed: regras.TIPOS_DE_VIDEO });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Vídeo vazio' });
    }
    // Na query (e não em cabeçalho próprio, que o CORS barraria): só telemetria.
    const formatoPedido = String(req.query.formato || '').trim();
    const formato = regras.FORMATOS.includes(formatoPedido) ? formatoPedido : null;

    try {
      const q = await buscarOrcamento(qid, cid);
      if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
      if (!regras.STATUS_ABERTOS.includes(q.status)) {
        return res.status(400).json({ error: 'Só dá para gravar vídeo de um orçamento em aberto' });
      }

      const chave = regras.chaveDoVideo(cid, qid, contentType);
      const subiu = await r2.uploadToR2(chave, req.body, contentType);
      if (!subiu || !subiu.success) {
        return res.status(502).json({ error: 'Não foi possível guardar o vídeo agora' });
      }

      const expira = regras.novaExpiracao(null, new Date());
      const upd = await db.query(
        `UPDATE studio_quotes
            SET video_key          = $1,
                video_content_type = $2,
                video_bytes        = $3,
                video_formato      = $4,
                video_gerado_em    = NOW(),
                video_expira_em    = $5,
                updated_at         = NOW()
          WHERE id = $6 AND company_id = $7
          RETURNING *`,
        [chave, contentType, req.body.length, formato, expira.toISOString(), qid, cid]
      );

      // O vídeo anterior deste orçamento sai do R2 (um vídeo por orçamento).
      if (q.video_key && q.video_key !== chave) {
        r2.deleteFromR2(q.video_key).catch(() => {});
      }

      res.status(201).json({ video: resumoDoVideo(upd.rows[0]) });
    } catch (err) {
      if (semColuna(err)) return res.status(503).json({ error: 'Orçamento em vídeo ainda não está disponível' });
      console.error('[studio/quotes/:qid/video:PUT]', err.message);
      res.status(500).json({ error: 'Erro ao guardar o vídeo' });
    }
  }
);

// ─── GET /quotes/:qid/video ──────────────────────────────────
router.get('/quotes/:qid/video', async function(req, res) {
  try {
    const q = await buscarOrcamento(req.params.qid, req.params.id);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (!q.video_key) return res.status(404).json({ error: 'Este orçamento não tem vídeo guardado' });
    if (q.video_expira_em && new Date(q.video_expira_em) < new Date()) {
      return res.status(410).json({ error: 'O vídeo deste orçamento expirou' });
    }
    const arquivo = await r2.downloadFromR2(q.video_key);
    if (!arquivo) return res.status(404).json({ error: 'O vídeo não foi encontrado no armazenamento' });
    res.setHeader('Content-Type', q.video_content_type || 'video/mp4');
    res.setHeader('Content-Length', String(arquivo.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(arquivo);
  } catch (err) {
    if (semColuna(err)) return res.status(404).json({ error: 'Este orçamento não tem vídeo guardado' });
    console.error('[studio/quotes/:qid/video:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar o vídeo' });
  }
});

// ─── POST /quotes/:qid/video/manter ──────────────────────────
router.post('/quotes/:qid/video/manter', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;
  try {
    const q = await buscarOrcamento(qid, cid);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (!q.video_key) return res.status(404).json({ error: 'Este orçamento não tem vídeo guardado' });
    const agora = new Date();
    if (q.video_expira_em && new Date(q.video_expira_em) < agora) {
      return res.status(410).json({ error: 'O vídeo deste orçamento já expirou' });
    }
    const expira = regras.novaExpiracao(q.video_expira_em, agora);
    const upd = await db.query(
      `UPDATE studio_quotes
          SET video_expira_em = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING *`,
      [expira.toISOString(), qid, cid]
    );
    res.json({ video: resumoDoVideo(upd.rows[0]) });
  } catch (err) {
    console.error('[studio/quotes/:qid/video/manter]', err.message);
    res.status(500).json({ error: 'Erro ao prorrogar o vídeo' });
  }
});

// ─── POST /quotes/:qid/marcar-enviado ────────────────────────
// O envio acontece no WhatsApp da lojista (folha de compartilhamento ou
// wa.me). O painel só registra que foi e por onde. Não gera token: este
// fluxo não tem página pública (decisão do PO, 28/09).
router.post('/quotes/:qid/marcar-enviado', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;
  const canalPedido = String((req.body && req.body.canal) || '').trim();
  const canal = regras.CANAIS.includes(canalPedido) ? canalPedido : null;

  try {
    const q = await buscarOrcamento(qid, cid);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (!regras.STATUS_ABERTOS.includes(q.status)) {
      return res.status(400).json({ error: `Não é possível enviar orçamento com status '${q.status}'` });
    }
    const vDays = Math.max(1, parseInt(q.validity_days, 10) || 7);
    // Reenvio depois de "Cliente pediu ajuste" (362): a versão sobe e o
    // selo sai. Sem ajuste pendente (ou sem a 362) nada disso é tocado.
    const reenvioDeAjuste = q.ajuste_pedido_em != null;
    const upd = await db.query(
      `UPDATE studio_quotes
          SET status      = 'sent',
              sent_at     = NOW(),
              expires_at  = NOW() + ($1 || ' days')::interval,
              canal_envio = $2,${reenvioDeAjuste ? `
              versao           = versao + 1,
              ajuste_pedido_em = NULL,` : ''}
              updated_at  = NOW()
        WHERE id = $3 AND company_id = $4
        RETURNING *`,
      [String(vDays), canal, qid, cid]
    );
    res.json({ quote: upd.rows[0] });
  } catch (err) {
    if (semColuna(err)) return res.status(503).json({ error: 'Orçamento em vídeo ainda não está disponível' });
    console.error('[studio/quotes/:qid/marcar-enviado]', err.message);
    res.status(500).json({ error: 'Erro ao registrar o envio' });
  }
});

// ─── POST /quotes/:qid/fechar ────────────────────────────────
router.post('/quotes/:qid/fechar', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;
  const motivo = req.body && req.body.motivo ? String(req.body.motivo).trim().slice(0, 500) : null;
  try {
    const q = await buscarOrcamento(qid, cid);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (q.status === 'closed') return res.json({ quote: q });
    if (!['draft', 'sent', 'accepted'].includes(q.status)) {
      return res.status(400).json({ error: `Não é possível fechar orçamento com status '${q.status}'` });
    }
    const upd = await db.query(
      `UPDATE studio_quotes
          SET status        = 'closed',
              responded_at  = NOW(),
              response_note = COALESCE($1, response_note),
              updated_at    = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING *`,
      [motivo, qid, cid]
    );
    res.json({ quote: upd.rows[0] });
  } catch (err) {
    // Sem a 361 o CHECK ainda não aceita 'closed' (23514).
    if (err && err.code === '23514') return res.status(503).json({ error: 'Fechar orçamento ainda não está disponível' });
    console.error('[studio/quotes/:qid/fechar]', err.message);
    res.status(500).json({ error: 'Erro ao fechar o orçamento' });
  }
});

// ─── POST /quotes/:qid/ajuste ────────────────────────────────
// O cliente pediu, no WhatsApp da lojista, para mudar algo no orçamento
// enviado. Registro interno: guarda o texto e a versão que o cliente viu,
// e o orçamento volta a 'draft' para ela editar peça, arte, cor, valores
// e condições. O vídeo antigo fica guardado até ela gerar outro.
// Um só comando (CTE): só registra se o orçamento ainda estava 'sent'.
router.post('/quotes/:qid/ajuste', async function(req, res) {
  const cid = req.params.id;
  const qid = req.params.qid;
  const lido = regras.lerPedidoDeAjuste(req.body);
  if (!lido.ok) return res.status(400).json({ error: lido.erro });

  try {
    const q = await buscarOrcamento(qid, cid);
    if (!q) return res.status(404).json({ error: 'Orçamento não encontrado' });
    if (q.status !== 'sent') {
      return res.status(400).json({ error: 'Só dá para registrar ajuste de um orçamento enviado' });
    }
    const r = await db.query(
      `WITH q AS (
         UPDATE studio_quotes
            SET status           = 'draft',
                ajuste_pedido_em = NOW(),
                updated_at       = NOW()
          WHERE id = $1 AND company_id = $2 AND status = 'sent'
          RETURNING *
       ), a AS (
         INSERT INTO studio_quote_ajustes (quote_id, company_id, texto, versao, created_by)
         SELECT id, company_id, $3, versao, $4 FROM q
         RETURNING id, texto, versao, created_at
       )
       SELECT (SELECT row_to_json(q) FROM q) AS quote,
              (SELECT row_to_json(a) FROM a) AS ajuste`,
      [qid, cid, lido.texto, (req.user && req.user.id) || null]
    );
    const linha = r.rows[0] || {};
    if (!linha.quote) {
      return res.status(409).json({ error: 'O orçamento mudou enquanto você registrava. Abra de novo.' });
    }
    res.status(201).json({ quote: linha.quote, ajuste: linha.ajuste });
  } catch (err) {
    if (semColuna(err)) return res.status(503).json({ error: 'Pedido de ajuste ainda não está disponível' });
    console.error('[studio/quotes/:qid/ajuste]', err.message);
    res.status(500).json({ error: 'Erro ao registrar o pedido de ajuste' });
  }
});

router.resumoDoVideo = resumoDoVideo;
module.exports = router;
