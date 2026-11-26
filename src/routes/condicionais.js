// ============================================================
// AURA. — Venda condicional da loja (C2, 25/11/2026)
//
// Montado em private.js sob /condicionais (o /companies/:id e o
// requireCompanyAccess vem de la). Permissao: a mesma de Vendas (acesso a
// loja; a aba e a chave vendas.condicionais sao do app). SEM requirePlan no
// prefixo: a chave do modulo (vendas.condicionais, services/modules.js) e do
// Essencial, como vendas.pedidos.
//
// POST /condicionais        → 201 {condicional, avisos}
//                             200 {condicional, idempotent_replay} na mesma chave
//   corpo: { customer_id, customer_name?, customer_phone?,
//            items: [{product_id, variant_id?}] (uma peca por linha),
//            due_date? 'YYYY-MM-DD' (ausente = prazo padrao da loja),
//            seller_id?, employee_id?, seller_name?, notes? }
//   cabecalho: Idempotency-Key (ou idempotency_key no corpo)
//   erros: 422 COND_SEM_PECAS | COND_PECAS_DEMAIS | COND_ITEM_INVALIDO |
//              COND_QUANTIDADE | COND_CLIENTE_OBRIGATORIO | COND_CLIENTE_NOME |
//              COND_TELEFONE | PHONE_TOO_LONG | COND_DATA | COND_VENDEDORA |
//              COND_ITEM_NAO_PECA | COND_VARIANTE_OBRIGATORIA
//          404 CUSTOMER_NOT_FOUND | PRODUCT_NOT_FOUND
//          409 COND_SEM_SALDO {faltas} | IDEMPOTENCY_KEY_REUSED {condicional_id}
//              | COND_CONFLITO
//          503 COND_INDISPONIVEL (base sem a migration 467)
// GET  /condicionais        → {condicionais, filtro, hoje, totalizador, valor_a_cobrar, counts, pagination}
//   ?filtro=em_aberto (padrao)|com_cliente|vence_hoje|atrasadas|a_cobrar|concluidas|canceladas|todas
//   &q= (nome, peca, numero "31"/"C-0031" ou telefone) &page= &limit=
// GET  /condicionais/:cid   → {condicional} com items (preco_hoje ao lado
//                             do unit_price da retirada) e events
//
// Regras do que a condicional faz (e do que NAO faz): cabecalho de
// services/condicional.js. Trava CONDICIONAL_LIBERADA: desligada, so a
// equipe Aura usa; para o lojista a rota responde 404 como se nao existisse.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const condicional = require('../services/condicional');
const listaDeCondicionais = require('../services/listaDeCondicionais');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAO_ENCONTRADA = { error: 'Condicional não encontrada.', code: 'COND_NAO_ENCONTRADA' };

function falhar(res, err, contexto, mensagem500) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.condicional_id ? { condicional_id: err.condicional_id } : {}),
      ...(err.product_id ? { product_id: err.product_id } : {}),
      ...(err.faltas ? { faltas: err.faltas } : {}),
    });
  }
  // Migration 467 ainda nao aplicada (deploy parcial).
  if (err && (err.code === '42703' || err.code === '42P01')) {
    return res.status(503).json({
      error: 'As condicionais ainda não estão disponíveis. Tente de novo em instantes.',
      code: 'COND_INDISPONIVEL',
    });
  }
  console.error(`[condicionais:${contexto}]`, err && err.message, err && err.code);
  return res.status(500).json({
    error: mensagem500 || 'Não deu para guardar a condicional agora. Nada foi gravado. Tente de novo em instantes.',
  });
}

// Trava do recurso: desligada, a rota nao existe para o lojista.
router.use((req, res, next) => {
  if (!condicional.condicionalLiberada(req)) return res.status(404).json({ error: 'Não encontrado' });
  return next();
});

router.post('/', async (req, res) => {
  try {
    const r = await condicional.guardarCondicional({
      companyId: req.params.id,
      userId: req.user && req.user.id,
      body: req.body,
      chave: condicional.lerChave(req),
    });
    if (r.repetido) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(200).json({ condicional: r.condicional, idempotent_replay: true });
    }
    // Com "vender sem estoque" ligado, o que passou do livre vem em `avisos`
    // (mesmo formato de `faltas` do 409). [] = tudo livre.
    return res.status(201).json({ condicional: r.condicional, avisos: r.avisos || [] });
  } catch (err) {
    return falhar(res, err, 'guardar');
  }
});

router.get('/', async (req, res) => {
  try {
    const out = await listaDeCondicionais.listarCondicionais(db, {
      empresas: [req.params.id],
      filtro: req.query.filtro || req.query.situacao,
      busca: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
      hoje: condicional.hojeSP(),
    });
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) {
    return falhar(res, err, 'listar', 'Não conseguimos carregar as condicionais agora. Tente de novo em instantes.');
  }
});

router.get('/:cid', async (req, res) => {
  const { id: companyId, cid } = req.params;
  if (!UUID_RE.test(String(cid))) return res.status(404).json(NAO_ENCONTRADA);
  try {
    const c = await condicional.lerCondicionalCompleta(db, companyId, cid, { hoje: condicional.hojeSP() });
    if (!c) return res.status(404).json(NAO_ENCONTRADA);
    res.set('Cache-Control', 'no-store');
    return res.json({ condicional: c });
  } catch (err) {
    return falhar(res, err, 'detalhe', 'Não conseguimos abrir a condicional agora. Tente de novo em instantes.');
  }
});

module.exports = router;
