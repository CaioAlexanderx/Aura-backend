// ============================================================
// AURA. — Estoque só consulta (permissão estoque_consulta)
//
// 30/10/2026: funcionário que vê produtos e quantidades, sem preços, custos
// nem valores, e não grava nada. A chave mora em company_members.permissions
// (jsonb); sem migration e sem whitelist (as rotas de membros gravam o objeto
// como veio).
//
// Quem é restringido: membro com permissions.estoque_consulta === true.
// Dono, papel admin, staff (req.user.role === 'admin') e permissions null
// nunca são. Com estoque e estoque_consulta ligados, vale o mais restritivo:
// consulta. A permissão é por empresa (:id da rota), então o mesmo usuário
// pode ser restrito numa loja do grupo e não em outra.
//
// O que fica em GET /products*:
//   - só as leituras de LEITURAS_LIBERADAS, com os campos de dinheiro fora;
//   - o resto (ranking, etiquetas, rascunhos...) responde 403;
//   - rota nova sob /products nasce fechada para esse perfil.
//
// Preço: o Caixa lê preço, preço no cartão e price_override do GET /products
// e das variantes (hooks/usePdvState.ts usa useProducts). Quem também tem a
// permissão pdv continua recebendo esses campos, senão vende a R$ 0,00; a
// tela de Estoque esconde. Quem não tem pdv não recebe. Custo e margem não
// saem para ninguém deste perfil: o Caixa não os lê.
//
// Custo: 1 SELECT só para membro que não é dono/admin, e 1 vez por request.
// Se a leitura falhar, nega (503): é a mesma trava que protege o custo.
//
// 03/11/2026 — CUSTO OCULTO (pedido do PO). Funcionário com Caixa e Estoque
// mas sem Financeiro, Painel e o resto da retaguarda não vê custo, margem
// nem valor do estoque — continua vendo preço e gravando produto. Em
// produção já havia 2 membros assim ({pdv, estoque, clientes, painel:false})
// recebendo o custo de tudo. Regra em podeVerCusto:
//   - dono, admin, staff e permissions null: vê;
//   - permissions.custos (boolean) decide quando o dono marcou na equipe;
//   - sem a chave: vê quem tem financeiro, relatorios, configuracoes ou
//     painel (painel AUSENTE conta como ligado, igual ao front —
//     hooks/useVisibleModules.ts libera o Painel quando a chave falta).
// Quem não vê: mesmos mounts do estoque_consulta, mas só o CUSTO sai (preço
// fica) e nada é bloqueado; na escrita sob /products os campos de custo do
// corpo são descartados, para quem não vê o custo não apagá-lo ao salvar.
// ============================================================
const db = require('../config/database');

const CODIGO = 'ESTOQUE_SO_CONSULTA';
const MENSAGEM = 'Este acesso é só para consultar o estoque.';

// Caminhos relativos ao mount /products.
const LEITURAS_LIBERADAS = [
  /^\/?$/,                      // lista
  /^\/variants\/?$/,            // variantes em lote
  /^\/[^/]+\/variants\/?$/,     // variantes de um produto
  /^\/[^/]+\/variations\/?$/,   // grade de um produto
  /^\/[^/]+\/images\/?$/,       // fotos
  /^\/barcode\/[^/]+\/?$/,      // um produto pelo código
  /^\/duplicate-groups\/?$/,    // a tela consulta ao montar
];

const CAMPOS_DE_CUSTO = new Set([
  'cost_price', 'cost', 'avg_cost', 'unit_cost',
  'margin', 'margin_pct', 'margem', 'margem_pct', 'lucro', 'profit',
  'total_value', 'stock_value', 'valor_estoque', 'valor_total',
  // 02/11/2026: os nomes com que o custo sai fora de /products (Matcon
  // compras, ficha técnica do food, margem, fornecedor).
  'last_purchase_unit_cost', 'unit_cost_est', 'est_cost', 'total_est',
  'total_est_cost', 'stock_unit_cost', 'total_cost', 'custo_total',
  'custo_medio', 'margin_alert', 'margem_catalogo', 'waste_cost',
  'total_waste_cost',
]);

// Saem só de quem não tem a permissão pdv (ver o cabeçalho).
const CAMPOS_DE_PRECO = new Set([
  'price', 'price_override', 'base_price', 'card_price',
  'avg_price', 'sale_price', 'effective_price',
]);

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Chaves que mostram dinheiro da loja: quem tem uma delas já vê custo.
const CHAVES_QUE_VEEM_CUSTO = ['financeiro', 'relatorios', 'configuracoes', 'painel'];

// Regra pura, sem banco (ver o cabeçalho, 03/11/2026).
function podeVerCusto({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin') return true;
  if (!permissions) return true;
  if (permissions.estoque_consulta === true) return false;
  if (typeof permissions.custos === 'boolean') return permissions.custos;
  if (permissions.painel === undefined) return true;
  return CHAVES_QUE_VEEM_CUSTO.some((k) => permissions[k] === true);
}

// Campos de custo no CORPO da escrita: quem não vê custo não grava custo.
const CUSTO_NA_ESCRITA = ['cost_price', 'cost', 'unit_cost', 'weighted_avg_cost', 'last_purchase_unit_cost'];

function semCustoNaEscrita(body) {
  if (Array.isArray(body)) return body.map(semCustoNaEscrita);
  if (body === null || typeof body !== 'object') return body;
  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (CUSTO_NA_ESCRITA.includes(k)) continue;
    out[k] = semCustoNaEscrita(v);
  }
  return out;
}

// Regra pura, sem banco.
function ehSoConsulta({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin') return false;
  if (!permissions) return false;
  return permissions.estoque_consulta === true;
}

// Tira os campos de dinheiro em qualquer profundidade. Só entra em array e
// objeto simples: Date e afins passam intactos. `extras`: chaves de custo
// que só valem num mount (o "total" dos pedidos de compra é custo; o de uma
// venda não é).
function semValores(valor, removerPreco, extras) {
  if (Array.isArray(valor)) return valor.map((v) => semValores(v, removerPreco, extras));
  if (valor === null || typeof valor !== 'object') return valor;
  const proto = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) return valor;
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    if (CAMPOS_DE_CUSTO.has(k)) continue;
    if (extras && extras.has(k)) continue;
    if (removerPreco && CAMPOS_DE_PRECO.has(k)) continue;
    out[k] = semValores(v, removerPreco, extras);
  }
  return out;
}

// Devolve { ativo, podeVerPreco, ocultarCusto }. Guardado no request: o
// mesmo pedido pode passar por mais de um mount. `ativo` = estoque_consulta;
// `ocultarCusto` = não vê custo (consulta sempre; os outros pela regra
// podeVerCusto).
async function lerConsulta(req) {
  if (req.estoqueConsulta) return req.estoqueConsulta;
  const livre = { ativo: false, podeVerPreco: true, ocultarCusto: false };
  if (!req.user || req.user.role === 'admin' || req.companyRole === 'owner' || req.companyRole === 'admin') {
    req.estoqueConsulta = livre;
    return livre;
  }
  const sql =
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`;
  const params = [req.params.id, req.user.id];
  const { rows } = await (typeof db.queryRetry === 'function' ? db.queryRetry(sql, params) : db.query(sql, params));
  const r = rows[0];
  const permissions = r ? lerPermissoes(r.permissions) : null;
  const quem = r ? { isOwner: r.is_owner, roleLabel: r.role_label, permissions } : null;
  const ativo = !!quem && ehSoConsulta(quem);
  if (ativo) {
    req.estoqueConsulta = { ativo: true, podeVerPreco: permissions.pdv === true, ocultarCusto: true };
  } else if (quem && !podeVerCusto(quem)) {
    req.estoqueConsulta = { ativo: false, podeVerPreco: true, ocultarCusto: true };
  } else {
    req.estoqueConsulta = livre;
  }
  return req.estoqueConsulta;
}

const ehLeitura = (req) => req.method === 'GET' || req.method === 'HEAD';

function negar(res) {
  return res.status(403).json({ error: MENSAGEM, code: CODIGO });
}

// `semCusto(req, res, next)`: o que fazer com quem só não vê custo (sem ele,
// passa direto, como sempre foi).
function comConsulta(decidir, semCusto) {
  return async (req, res, next) => {
    let consulta;
    try {
      consulta = await lerConsulta(req);
    } catch (err) {
      console.error('[estoqueSoConsulta] error:', err.message);
      return res.status(503).json({
        error: 'Instabilidade momentânea de conexão. Tente novamente.',
        code: 'DB_CONN_TRANSIENT',
      });
    }
    if (!consulta.ativo) {
      if (consulta.ocultarCusto && semCusto) return semCusto(req, res, next);
      return next();
    }
    return decidir(req, res, next, consulta);
  };
}

// Quem só não vê custo: a resposta sai sem custo (preço fica) e, na escrita,
// o corpo perde os campos de custo.
function tirarCusto(req, res, next, { escrita = false, extras = null } = {}) {
  if (escrita && !ehLeitura(req) && req.body) req.body = semCustoNaEscrita(req.body);
  const json = res.json.bind(res);
  res.json = (body) => json(semValores(body, false, extras));
  return next();
}

// Mount /products: fecha a escrita, abre só as leituras da tela e tira os
// campos de dinheiro da resposta.
const estoqueSoConsulta = comConsulta((req, res, next, consulta) => {
  if (!ehLeitura(req)) return negar(res);
  if (!LEITURAS_LIBERADAS.some((re) => re.test(req.path))) return negar(res);
  const json = res.json.bind(res);
  res.json = (body) => json(semValores(body, !consulta.podeVerPreco));
  return next();
}, (req, res, next) => tirarCusto(req, res, next, { escrita: true }));

// Mounts sem dinheiro na resposta (categorias, desfazer importação): só
// fecha a escrita.
const somenteLeituraEmConsulta = comConsulta((req, res, next) => (
  ehLeitura(req) ? next() : negar(res)
));
// (Quem só não vê custo passa direto aqui: categorias e importações não
// trazem custo na resposta.)

// Mounts que devolvem valor e não servem à tela (valor em risco de ruptura,
// margem por produto).
const negarEmConsulta = comConsulta((req, res) => negar(res));

// /estoque (ruptura): consulta continua negada; quem só não vê custo recebe
// a lista sem custo — a tela do "O que vai faltar" serve a quem repõe.
const negarEmConsultaSemCustoNoResto = comConsulta(
  (req, res) => negar(res),
  (req, res, next) => tirarCusto(req, res, next),
);

// /margin: a tela inteira é margem — sem custo, não há o que mostrar.
const negarSemCusto = comConsulta((req, res) => negar(res), (req, res) => negar(res));

// 02/11/2026: mounts fora de /products que devolvem custo junto do que a
// tela precisa (bipe e venda do Caixa, troca, fornecedor, Matcon compras,
// food, materiais do Odonto). A resposta sai sem custo; o preço segue a
// regra de cima (fica para quem tem pdv). Não fecha escrita: o Caixa grava
// venda. Diferente de comConsulta, a falha ao ler a permissão não derruba
// o pedido (seria uma venda perdida no balcão): segue tirando só o custo.
// Dono e admin nunca chegam a essa leitura.
function semCustoEmConsulta(extras = []) {
  const chavesExtras = extras.length ? new Set(extras) : null;
  return async (req, res, next) => {
    let consulta;
    try {
      consulta = await lerConsulta(req);
    } catch (err) {
      console.error('[estoqueSoConsulta] error:', err.message);
      consulta = { ativo: true, podeVerPreco: true };
    }
    if (!consulta.ativo && !consulta.ocultarCusto) return next();
    const json = res.json.bind(res);
    res.json = (body) => json(semValores(body, consulta.ativo && !consulta.podeVerPreco, chavesExtras));
    return next();
  };
}

module.exports = {
  estoqueSoConsulta,
  somenteLeituraEmConsulta,
  negarEmConsulta,
  semCustoEmConsulta,
  negarEmConsultaSemCustoNoResto,
  negarSemCusto,
  lerConsulta,
  ehSoConsulta,
  podeVerCusto,
  semCustoNaEscrita,
  semValores,
  LEITURAS_LIBERADAS,
};
