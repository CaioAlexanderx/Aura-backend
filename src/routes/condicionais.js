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
// ─── Decidir as pecas (C9, 26/11/2026; services/condicionalDecidir.js) ──
// Todas: Idempotency-Key opcional (cabecalho ou corpo); a repeticao devolve
// a mesma resposta da primeira (avisos, itens_acrescentados) com 200 e
// idempotent_replay: true; a mesma chave com outra
// alteracao: 409 IDEMPOTENCY_KEY_REUSED. Nenhuma cria venda, lancamento ou
// caixa (R1). Condicional encerrada ou cancelada: 409 COND_FECHADA.
// PATCH /condicionais/:cid/itens  → 200 {condicional, avisos}
//   corpo: { items: [{item_id, situacao: 'voltou'|'voltou_defeito'|'ficou'|'com_cliente', defect_note?}] }
//   erros: 422 COND_SEM_PECAS | COND_PECAS_DEMAIS | COND_ITEM_INVALIDO |
//              COND_ITEM_REPETIDO | COND_SITUACAO
//          404 COND_PECA_NAO_ENCONTRADA {item_id}
//          409 COND_PECA_COBRADA {item_id, sale_id} | COND_PECA_RESOLVIDA {item_id}
//              | COND_SEM_SALDO {faltas} (peca que tinha voltado sai de novo)
// PATCH /condicionais/:cid/prazo  → 200 {condicional}
//   corpo: { due_date: 'YYYY-MM-DD' } de hoje (SP) a hoje + 30
//   erros: 422 COND_DATA; 409 COND_NADA_COM_ELA (falta so cobrar)
// POST  /condicionais/:cid/itens  → 201 {condicional, avisos, itens_acrescentados}
//   corpo: { items: [{product_id, variant_id?}] } (preco do dia, mesmo prazo)
//   erros: os do guardar para as pecas (422/404) + 409 COND_SEM_SALDO
//          {faltas} | COND_NADA_COM_ELA; 422 COND_PECAS_DEMAIS (total > 60)
// POST  /condicionais/:cid/tudo-devolvido → 200 {condicional} (encerrada)
//   erros: 409 COND_TEM_FICOU (peca "ficou" sem venda: cobrar ou marcar Voltou)
// POST  /condicionais/:cid/cancelar → 200 {condicional} (cancelada)
//   corpo: { reason? }
//   erros: 409 COND_CANCELAR_DECIDIDA (ja tem peca decidida: o caminho e Voltou)
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
const decidir = require('../services/condicionalDecidir');
const resolver = require('../services/condicionalResolver');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAO_ENCONTRADA = { error: 'Condicional não encontrada.', code: 'COND_NAO_ENCONTRADA' };

function falhar(res, err, contexto, mensagem500) {
  if (err && err.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.condicional_id ? { condicional_id: err.condicional_id } : {}),
      ...(err.product_id ? { product_id: err.product_id } : {}),
      ...(err.item_id ? { item_id: err.item_id } : {}),
      ...(err.sale_id ? { sale_id: err.sale_id } : {}),
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

// ─── Pecas para resolver (C16) ─────────────────────────────────
// Antes de /:cid: "para-resolver" nao e um id.
router.get('/para-resolver', async (req, res) => {
  try {
    const out = await resolver.listarParaResolver(db, { empresas: [req.params.id] });
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) {
    return falhar(res, err, 'para-resolver', 'Não conseguimos carregar as peças para resolver agora. Tente de novo em instantes.');
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

// ─── Decidir as pecas (C9) ─────────────────────────────────────

const MSG_ALTERAR = 'Não deu para salvar a condicional agora. Nada foi alterado. Tente de novo em instantes.';

/** Roda a operacao do C9 e responde no formato comum. */
function decisao(contexto, operacao, { statusNovo = 200 } = {}) {
  return async (req, res) => {
    const { id: companyId, cid } = req.params;
    if (!UUID_RE.test(String(cid))) return res.status(404).json(NAO_ENCONTRADA);
    try {
      const r = await operacao({
        companyId,
        condId: cid,
        userId: req.user && req.user.id,
        body: req.body,
        chave: condicional.lerChave(req),
        hoje: condicional.hojeSP(),
      });
      res.set('Cache-Control', 'no-store');
      const { condicional: c, repetido, ...extra } = r;
      if (repetido) {
        // A mesma resposta da primeira (avisos, itens_acrescentados vem do
        // evento da operacao) + a condicional como esta agora.
        res.set('Idempotent-Replayed', 'true');
        return res.status(200).json({ condicional: c, ...extra, idempotent_replay: true });
      }
      return res.status(statusNovo).json({ condicional: c, ...extra });
    } catch (err) {
      return falhar(res, err, contexto, MSG_ALTERAR);
    }
  };
}

router.patch('/:cid/itens', decisao('marcar', decidir.marcarPecas));
router.patch('/:cid/prazo', decisao('prazo', decidir.mudarPrazo));
router.post('/:cid/itens', decisao('acrescentar', decidir.acrescentarPecas, { statusNovo: 201 }));
router.post('/:cid/tudo-devolvido', decisao('tudo-devolvido', decidir.tudoDevolvido));
router.post('/:cid/cancelar', decisao('cancelar', decidir.cancelarCondicional));

// Resolver uma peca (C16): {acao: 'voltar_estoque'|'baixa', motivo?, motivo_texto?}
// → 200 {condicional, item_id, acao, desfazer_ate_s}. Erros: 422 COND_RESOLVER_ACAO |
// COND_RESOLVER_MOTIVO; 404 COND_PECA_NAO_ENCONTRADA; 409 COND_PECA_NAO_RESOLVER |
// COND_PECA_JA_RESOLVIDA | IDEMPOTENCY_KEY_REUSED. Desfazer (so voltar_estoque, em
// poucos segundos, se nada mudou): 409 COND_DESFAZER_EXPIRADO | COND_DESFAZER_BAIXA | COND_DESFAZER_NADA.
function acaoDaPeca(contexto, operacao) {
  return async (req, res) => {
    try {
      const r = await operacao({
        companyId: req.params.id,
        itemId: req.params.itemId,
        userId: req.user && req.user.id,
        body: req.body,
        chave: condicional.lerChave(req),
        hoje: condicional.hojeSP(),
      });
      res.set('Cache-Control', 'no-store');
      const { repetido, ...resto } = r;
      if (repetido) res.set('Idempotent-Replayed', 'true');
      return res.status(200).json({ ...resto, ...(repetido ? { idempotent_replay: true } : {}) });
    } catch (err) {
      return falhar(res, err, contexto, MSG_ALTERAR);
    }
  };
}
router.post('/itens/:itemId/resolver', acaoDaPeca('resolver', resolver.resolverPeca));
router.post('/itens/:itemId/resolver/desfazer', acaoDaPeca('resolver-desfazer', resolver.desfazerResolucao));

module.exports = router;
