// ============================================================
// AURA KARATÊ — Rota pública do PIX de cobrança (Fase F4/PIX)
// Montada em /public/karate (mesmo grupo CORS aberto de karatePublic.js
// — ver app.js). SEM auth: o token opaco assinado (karatePixPublicToken.js)
// é a única "chave".
//
//   GET /public/karate/pix/:token — dados mínimos pra renderizar a
//       página pública de pagamento (front: app/karate/pix/[token].tsx).
//       Resposta SÓ tem valor, competência e o BR Code — nunca nome,
//       CPF, telefone, e-mail ou qualquer id de dojô/praticante (ver
//       karatePixPublicToken.js para a justificativa de privacidade).
//
// O QR do PIX não é gerado aqui: o front já embute react-native-qrcode-svg
// (ver components/karate/PixQRCode.tsx, dependência já existente) e
// desenha o QR client-side a partir do `pix_code` devolvido — evita um
// endpoint de imagem novo (e a decisão de cache/exposição que ele traria).
// ============================================================
'use strict';

const router = require('express').Router();
const { verifyPixToken } = require('../services/karatePixPublicToken');

router.get('/pix/:token', (req, res) => {
  const data = verifyPixToken(req.params.token);
  if (!data) {
    return res.status(404).json({ error: 'Link inválido ou expirado', code: 'NOT_FOUND' });
  }
  return res.json({
    amount: data.amount,
    reference_period: data.referencePeriod,
    pix_code: data.pixCode,
  });
});

module.exports = router;
