// ============================================================
// AURA DOJÔ — F9.1 (público): verificação do CERTIFICADO DO DOJÔ
//
// Equivalente-dojô de GET /public/karate/verify/cert/:token (federação,
// dentro de karatePublic.js) — MAS um documento NÃO OFICIAL. A resposta
// é INEQUÍVOCA sobre isso: certificate_type:'dojo' + official:false + um
// aviso textual (`notice`), para quem verificar nunca confundir com o
// certificado oficial da FPKT (rota separada, intocada).
//
// Router PRÓPRIO, não editado dentro do já grande karatePublic.js —
// mesmo padrão de karateDojoPublic.js, karatePublicRanking.js e
// karatePixPublic.js: vários routers pequenos montados sob o mesmo
// prefixo /public/karate (ver src/routes/index.js). Isso evita reescrever
// um arquivo grande só para acrescentar uma rota que não compartilha
// nenhum helper com o resto dele.
//
// Sem auth — verificação pública por token opaco (verify_token, hex 32,
// gerado em karateDojoCertificates.js na emissão).
//   GET /public/karate/verify/dojo-cert/:token
//
// NÃO colide com GET /public/karate/verify/:token (carteirão, Track D,
// karatePublic.js): segmentos diferentes ('dojo-cert' vs o próprio
// token), e roteadores mergeParams tentados em sequência pelo Express —
// se um não casar a rota, cai para o próximo router montado no mesmo
// prefixo (mesmo mecanismo já usado por todos os /public/karate atuais).
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');

router.get('/verify/dojo-cert/:token', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ic.data_snapshot, ic.template_snapshot, ic.revoked, ic.issued_at,
              COALESCE(c.trade_name, c.legal_name) AS dojo_name
         FROM karate_dojo_issued_certificates ic
         JOIN companies c ON c.id = ic.dojo_id
        WHERE ic.verify_token = $1 LIMIT 1`,
      [req.params.token]
    );
    if (!r.rows.length) {
      return res.status(404).json({ valid: false, certificate_type: 'dojo', error: 'Certificado não encontrado' });
    }
    const row = r.rows[0];
    if (row.revoked) {
      return res.status(200).json({
        valid: false,
        revoked: true,
        certificate_type: 'dojo',
        official: false,
        error: 'Certificado revogado',
      });
    }
    res.json({
      valid: true,
      certificate_type: 'dojo',
      official: false,
      notice:
        'Este é o certificado emitido pelo PRÓPRIO DOJÔ — documento interno, sem valor oficial junto à federação. O certificado OFICIAL de graduação é emitido separadamente pela federação (FPKT).',
      issued_at: row.issued_at,
      dojo_name: row.dojo_name,
      data: row.data_snapshot,
      template: row.template_snapshot,
    });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(404).json({ valid: false, certificate_type: 'dojo', error: 'Certificado não encontrado' });
    }
    console.error('[karateDojoCertPublic] verify error:', err.message);
    res.status(500).json({ error: 'Erro ao verificar certificado' });
  }
});

module.exports = router;
