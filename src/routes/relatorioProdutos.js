// ============================================================
// AURA. — Financeiro › Relatórios › Produtos (p-114, 13/11/2026)
//
// Montado em /companies/:id/relatorios (requireAuth + requireCompanyAccess).
//
// GET /companies/:id/relatorios/produtos
//   modelo     estoque_acabando | mais_vendidos | parados_30 | mais_lucrativos |
//              margem_baixa | estoque_zerado | sem_custo (opcional; só padrões)
//   de, ate    YYYY-MM-DD, dia de São Paulo (padrão: os últimos 30 dias até hoje)
//   agrupar    item | produto
//   categoria  id (com as subcategorias) ou o nome antigo (products.category)
//   marca, busca (nome, SKU, código de barras), so_ativos (padrão 1)
//   estoque_min, estoque_max, com_estoque, vendeu, sem_custo, margem_max,
//   sem_vender_dias, acaba_em_dias
//   ordem, direcao, limit (1..200, padrão 50), offset, todas=1 (até 5.000)
//   escopo     loja | grupo
// Contrato e regras no topo de services/relatorioProdutos.js.
//
// Loja ou consolidado como a ruptura (routes/estoqueRuptura.js): com
// `consolidated_view` no token ou ?escopo=grupo, soma as lojas ativas do
// grupo de :id que o usuário alcança (dono ou membro ativo; staff, todas).
// ?escopo=loja explícito vale mais que o token.
//
// Quem vê (regra do custo oculto, middleware/estoqueSoConsulta.js):
//   - "estoque só consulta" (não vê preço nem valor): 403 ESTOQUE_SO_CONSULTA;
//   - quem não vê custo (podeVerCusto): o relatório sai com custo, lucro,
//     margem, valor parado, valor do estoque a custo e cobertura de custo em
//     null; os modelos de custo, a ordem por custo e os filtros sem_custo e
//     margem_max dão 403 RELATORIO_SEM_CUSTO (com `modelos_sem_custo`, para a
//     tela esconder os modelos). `pode_ver_custo` vem em toda resposta.
//   - no consolidado vale a loja mais restrita: se em alguma loja do escopo a
//     pessoa não vê custo, o custo some de tudo; loja onde ela é "só
//     consulta" fica fora do escopo.
// Sem requirePlan: Essencial e Negócio veem igual, como o resto do Financeiro.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { lerConsulta, podeVerCusto, ehSoConsulta } = require('../middleware/estoqueSoConsulta');
const { relatorioProdutos, normalizarParametros } = require('../services/relatorioProdutos');

const GRUPO = (a) => `COALESCE(NULLIF(${a}.billing_owner_company_id, ${a}.id), ${a}.id)`;

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Lojas ativas do grupo de :id que o usuário alcança, com o que ele vê em
// cada uma. Staff alcança todas e vê tudo.
async function lojasDoConsolidado(companyId, user) {
  const staff = user.role === 'admin';
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id,
            (c.owner_id = $2) AS is_owner,
            cm.role_label,
            cm.permissions,
            ($3::boolean OR c.owner_id = $2 OR cm.user_id IS NOT NULL) AS alcanca
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE ${GRUPO('c')} = (SELECT ${GRUPO('r')} FROM companies r WHERE r.id = $1)
        AND c.is_active = true
      ORDER BY c.id, (c.owner_id = $2) DESC`,
    [companyId, user.id, staff]
  );
  const lojas = [];
  let semCusto = false;
  for (const r of rows) {
    if (!r.alcanca) continue;
    if (staff || r.is_owner) { lojas.push(r.id); continue; }
    const quem = { isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions) };
    if (ehSoConsulta(quem)) continue;
    if (!podeVerCusto(quem)) semCusto = true;
    lojas.push(r.id);
  }
  return { lojas, semCusto };
}

function responderErro(res, err) {
  return res.status(err.statusCode).json({ error: err.message, code: err.code, ...(err.extra || {}) });
}

router.get('/produtos', async (req, res) => {
  const companyId = req.params.id;

  let consulta;
  try {
    consulta = await lerConsulta(req);
  } catch (err) {
    console.error('[relatorios/produtos] permissao:', err.message);
    return res.status(503).json({ error: 'Instabilidade momentânea de conexão. Tente novamente.', code: 'DB_CONN_TRANSIENT' });
  }
  if (consulta.ativo) {
    return res.status(403).json({ error: 'Este acesso é só para consultar o estoque.', code: 'ESTOQUE_SO_CONSULTA' });
  }

  try {
    const escopo = req.query.escopo;
    if (escopo !== undefined && !['loja', 'grupo'].includes(String(escopo))) {
      return res.status(400).json({ error: 'escopo deve ser loja ou grupo', code: 'RELATORIO_PARAMETRO' });
    }
    const consolidado = escopo === 'grupo' || (escopo !== 'loja' && req.user?.consolidated_view === true);
    let companyIds = [companyId];
    let veCusto = !consulta.ocultarCusto;
    if (consolidado) {
      const grupo = await lojasDoConsolidado(companyId, req.user);
      companyIds = Array.from(new Set([companyId, ...grupo.lojas]));
      if (grupo.semCusto) veCusto = false;
    }

    let parametros;
    try {
      parametros = normalizarParametros(req.query, { podeVerCusto: veCusto });
    } catch (err) {
      if (err.statusCode) return responderErro(res, err);
      throw err;
    }

    const relatorio = await relatorioProdutos({ companyId, companyIds, parametros });
    res.set('Cache-Control', 'no-store');
    return res.json(relatorio);
  } catch (err) {
    console.error('[relatorios/produtos] error:', err.message);
    return res.status(500).json({ error: 'Não conseguimos montar o relatório agora. Tente de novo em instantes.' });
  }
});

module.exports = router;
module.exports.lojasDoConsolidado = lojasDoConsolidado;
