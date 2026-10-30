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

// Regra pura, sem banco.
function ehSoConsulta({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin') return false;
  if (!permissions) return false;
  return permissions.estoque_consulta === true;
}

// Tira os campos de dinheiro em qualquer profundidade. Só entra em array e
// objeto simples: Date e afins passam intactos.
function semValores(valor, removerPreco) {
  if (Array.isArray(valor)) return valor.map((v) => semValores(v, removerPreco));
  if (valor === null || typeof valor !== 'object') return valor;
  const proto = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) return valor;
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    if (CAMPOS_DE_CUSTO.has(k)) continue;
    if (removerPreco && CAMPOS_DE_PRECO.has(k)) continue;
    out[k] = semValores(v, removerPreco);
  }
  return out;
}

// Devolve { ativo, podeVerPreco }. Guardado no request: o mesmo pedido pode
// passar por mais de um mount.
async function lerConsulta(req) {
  if (req.estoqueConsulta) return req.estoqueConsulta;
  const livre = { ativo: false, podeVerPreco: true };
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
  const ativo = !!r && ehSoConsulta({ isOwner: r.is_owner, roleLabel: r.role_label, permissions });
  req.estoqueConsulta = ativo ? { ativo: true, podeVerPreco: permissions.pdv === true } : livre;
  return req.estoqueConsulta;
}

function negar(res) {
  return res.status(403).json({ error: MENSAGEM, code: CODIGO });
}

function comConsulta(decidir) {
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
    if (!consulta.ativo) return next();
    return decidir(req, res, next, consulta);
  };
}

const ehLeitura = (req) => req.method === 'GET' || req.method === 'HEAD';

// Mount /products: fecha a escrita, abre só as leituras da tela e tira os
// campos de dinheiro da resposta.
const estoqueSoConsulta = comConsulta((req, res, next, consulta) => {
  if (!ehLeitura(req)) return negar(res);
  if (!LEITURAS_LIBERADAS.some((re) => re.test(req.path))) return negar(res);
  const json = res.json.bind(res);
  res.json = (body) => json(semValores(body, !consulta.podeVerPreco));
  return next();
});

// Mounts sem dinheiro na resposta (categorias, desfazer importação): só
// fecha a escrita.
const somenteLeituraEmConsulta = comConsulta((req, res, next) => (
  ehLeitura(req) ? next() : negar(res)
));

// Mounts que devolvem valor e não servem à tela (valor em risco de ruptura).
const negarEmConsulta = comConsulta((req, res) => negar(res));

module.exports = {
  estoqueSoConsulta,
  somenteLeituraEmConsulta,
  negarEmConsulta,
  ehSoConsulta,
  semValores,
  LEITURAS_LIBERADAS,
};
