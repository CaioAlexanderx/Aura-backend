// ============================================================
// AURA DOJÔ — F11: lista PÚBLICA de federações (seletor do cadastro)
//
//   GET /public/karate/federations  ->  { federations: [{ id, name }] }
//
// Por que existe: no autocadastro (POST /auth/register com
// vertical='karate_dojo') o sensei precisa ESCOLHER a federação, e nesse
// momento ele ainda não tem conta — nenhuma rota autenticada serve. Antes
// desta rota não havia caminho público equivalente: todos os routers
// montados sob /public/karate (karatePublic, karatePublicRanking,
// karateDojoPublic, karateDojoCertPublic, karatePixPublic) partem de um
// :slug/token de UMA federação já conhecida; nenhum LISTA federações.
//
// SUPERFÍCIE MÍNIMA DE PROPÓSITO: devolve id + nome e nada mais. Não expõe
// CNPJ, contato, contagem de dojôs/praticantes nem slug — é um seletor de
// formulário, não um diretório. Qualquer campo novo aqui vira dado público
// permanente.
//
// Filtro canônico: companies.vertical = 'karate_federation' (o campo de
// identidade permanente, ver src/config/karateRoles.js) + is_active. Nome
// via COALESCE(name, trade_name, legal_name) — `companies.name` é nullable
// e `legal_name` é o único NOT NULL, então a cadeia nunca devolve vazio.
//
// ⚠️ Rota ESTÁTICA de 1 segmento: montada em src/routes/index.js ANTES de
// todos os outros routers /public/karate para nunca ser capturada como
// :slug (mesma armadilha de /dojos/roster-progress e /public/karate/dojo).
// ============================================================
'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Endpoint público e cacheável: 60/min por IP já é folga enorme para um
// formulário de cadastro e fecha a porta para varredura.
const federationsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv(),
});

// ── GET /public/karate/federations ──────────────────────────
// 200 { federations: [...] } — lista vazia é resposta legítima (nunca 404):
// o front mostra "nenhuma federação disponível" em vez de tela de erro.
router.get('/federations', federationsLimiter, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id,
              COALESCE(NULLIF(c.name, ''), NULLIF(c.trade_name, ''), c.legal_name) AS name
         FROM companies c
        WHERE c.vertical = 'karate_federation'
          AND c.is_active = true
        ORDER BY COALESCE(NULLIF(c.name, ''), NULLIF(c.trade_name, ''), c.legal_name) ASC`
    );

    // 5 min: a lista muda em escala de meses; evita bater no banco a cada
    // vez que alguém abre o passo 2 do cadastro.
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      federations: rows.map((r) => ({ id: r.id, name: r.name })),
    });
  } catch (err) {
    // Defensivo a schema (42703 coluna / 42P01 tabela): seletor vazio é
    // melhor que 500 numa tela de cadastro.
    if (err && (err.code === '42703' || err.code === '42P01')) {
      return res.json({ federations: [] });
    }
    console.error('[karateFederationsPublic] list error:', err.message);
    return res.status(500).json({ error: 'Erro ao listar federações' });
  }
});

module.exports = router;
