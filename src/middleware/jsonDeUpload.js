// ============================================================
// Parser JSON com teto maior, so para as rotas de upload do Studio
//
// O express.json global (src/app.js) tem limite de 5 MB. As duas rotas
// de upload do Studio recebem o arquivo em base64 no corpo e aceitam ate
// 15 MB de arquivo (UPLOAD_MAX_BYTES / MAX_SIZE_MB) — mas o parser global
// barrava antes: 5 MB de base64 sao ~3,7 MB de arquivo. A foto da cliente
// tirada no celular passava disso e voltava "request entity too large",
// em ingles e sem dizer o limite.
//
// 15 MB de arquivo viram ~20 MB em base64 (+ o resto do JSON); 25 MB de
// corpo cobrem com folga. O limite de 15 MB do ARQUIVO continua sendo
// conferido na rota, depois de decodificar.
//
// Registrado em app.js ANTES do parser global: o body-parser marca
// req._body e o global pula quem ja foi lido. Nenhuma outra rota muda.
// ============================================================
'use strict';

const express = require('express');

const LIMITE_DO_CORPO_DE_UPLOAD = '25mb';
const MENSAGEM_ARQUIVO_GRANDE = 'arquivo muito grande (max 15MB)';

/**
 * Caminhos reais (com /api/v1) das rotas de upload do Studio:
 *   - vitrine publica: routes/index.js monta studioStorefront em /storefront
 *   - painel: routes/index.js monta private.js em /companies/:id, e
 *     private.js monta studioUpload em /studio
 */
const ROTAS_DE_UPLOAD = [
  '/api/v1/storefront/:slug/studio/upload',
  '/api/v1/companies/:id/studio/upload-mockup',
];

/**
 * @param {object} [opcoes]
 * @param {string} [opcoes.limite]  teto do corpo (default 25mb)
 * @param {Function} [opcoes.verify] o mesmo verify do parser global
 */
function jsonDeUpload({ limite = LIMITE_DO_CORPO_DE_UPLOAD, verify } = {}) {
  const parser = express.json({ limit: limite, verify });
  return function parserDeUpload(req, res, next) {
    parser(req, res, (err) => {
      if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: MENSAGEM_ARQUIVO_GRANDE });
      }
      next(err);
    });
  };
}

/** Monta o parser nas rotas de upload (so POST). Chamar antes do express.json global. */
function montarJsonDeUpload(app, opcoes) {
  const mw = jsonDeUpload(opcoes);
  for (const rota of ROTAS_DE_UPLOAD) app.post(rota, mw);
  return app;
}

module.exports = {
  jsonDeUpload,
  montarJsonDeUpload,
  ROTAS_DE_UPLOAD,
  LIMITE_DO_CORPO_DE_UPLOAD,
  MENSAGEM_ARQUIVO_GRANDE,
};
