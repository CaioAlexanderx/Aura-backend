// ============================================================
// AURA. — E1: GET /catalog/health (F0, Onda E)
// Montado sob /companies/:id.
//
// Fecha o inventário do contrato §5: cobertura de categoria, foto,
// descrição, custo, marca e contagem de órfãos — mais a quebra POR
// CATEGORIA, que é o que torna o índice acionável para o lojista.
//
// LEITURA: sem gate de plano. Ver o buraco do próprio catálogo não pode
// depender de plano (CLAUDE.md, armadilha 3) — é o número que motiva a
// contratar, não o que se vende.
//
// A lógica vive em services/catalogHealth.js; aqui só o transporte.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { health } = require('../services/catalogHealth');

router.get('/catalog/health', async (req, res) => {
  try {
    res.json(await health(req.params.id));
  } catch (err) {
    console.error('[catalog/health] error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular a saúde do catálogo' });
  }
});

module.exports = router;
