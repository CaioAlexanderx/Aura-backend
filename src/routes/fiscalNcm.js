// ============================================================
// AURA. — Consulta de NCM na tabela da Receita (t3-05, 18/10/2026)
//
//   GET /fiscal/ncm/:codigo   (qualquer usuario autenticado)
//     → { ncm, formato_ok, existe, descricao, mensagem, tabela }
//
// `existe` é true/false, ou null quando não dá para saber (código com menos
// ou mais de 8 dígitos, ou tabela indisponível). `mensagem` só vem quando há
// algo a avisar. É consulta de dado público: não depende da empresa e não
// grava nada; o cadastro de produto usa para avisar ao sair do campo NCM.
// ============================================================
'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { consultarNcm, avisoDeNcm, versaoDaTabela } = require('../services/ncmTable');

router.get('/ncm/:codigo', requireAuth, (req, res) => {
  const raw = String(req.params.codigo || '').slice(0, 20);
  const r = consultarNcm(raw);
  if (r.vazio) return res.status(400).json({ error: 'Informe o NCM' });
  const aviso = avisoDeNcm(raw, { salvo: true });
  res.json({
    ncm: r.ncm,
    formato_ok: r.formatoOk,
    existe: r.existe,
    descricao: r.descricao,
    mensagem: aviso ? aviso.mensagem : null,
    tabela: versaoDaTabela(),
  });
});

module.exports = router;
