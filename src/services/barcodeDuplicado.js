// ============================================================
// AURA. — Código de barras repetido no cadastro de produto
//
// products tem UNIQUE (company_id, barcode). Criar ou editar um produto
// com um código que outro produto da loja já usa estourava 23505 e a rota
// devolvia 500 "Erro ao criar produto" — a lojista tentava de novo sem
// entender (14/11/2026: 3 tentativas seguidas numa gráfica).
//
// Agora vira 409 dizendo QUAL produto já tem o código. O produto excluído
// "com histórico" fica arquivado (is_active = false) e continua segurando
// o código, então a mensagem diz isso também — senão a lojista procura e
// não acha o produto na lista.
// ============================================================
'use strict';

const CONSTRAINT = 'products_company_id_barcode_key';

/** O erro é o UNIQUE do código de barras do produto? */
function ehBarcodeDuplicado(err) {
  if (!err || err.code !== '23505') return false;
  return err.constraint === CONSTRAINT || String(err.message || '').includes(CONSTRAINT);
}

/** Texto para a lojista, a partir do produto que já usa o código. */
function mensagemDoBarcodeDuplicado(barcode, dono) {
  const codigo = barcode ? `O código de barras ${barcode}` : 'Este código de barras';
  if (!dono) return `${codigo} já está em outro produto da loja. Use outro código ou deixe o campo vazio.`;
  if (dono.is_active === false) {
    return `${codigo} pertence ao produto "${dono.name}", que foi excluído mas ficou guardado por causa do histórico de vendas. Use outro código ou deixe o campo vazio.`;
  }
  return `${codigo} já está no produto "${dono.name}". Use outro código, deixe o campo vazio ou edite aquele produto.`;
}

/**
 * Se `err` é o código de barras repetido, devolve { status: 409, body };
 * senão, null (a rota segue com o 500 de sempre). A busca do dono nunca
 * derruba a resposta: se falhar, a mensagem sai sem o nome.
 */
async function respostaDeBarcodeDuplicado(db, err, { companyId, barcode, exceptId } = {}) {
  if (!ehBarcodeDuplicado(err)) return null;
  // A busca usa o valor exato que foi gravado (o INSERT/UPDATE não apara);
  // a mensagem mostra aparado.
  const bruto = barcode === undefined || barcode === null ? '' : String(barcode);
  const codigo = bruto.trim();
  let dono = null;
  if (bruto && companyId) {
    try {
      const { rows } = await db.query(
        `SELECT id, name, is_active FROM products
          WHERE company_id = $1 AND barcode = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
          ORDER BY is_active DESC LIMIT 1`,
        [companyId, bruto, exceptId || null]
      );
      dono = rows[0] || null;
    } catch (_) { dono = null; }
  }
  return {
    status: 409,
    body: {
      error: mensagemDoBarcodeDuplicado(codigo, dono),
      code: 'BARCODE_DUPLICADO',
      ...(dono ? { produto_existente: { id: dono.id, name: dono.name, arquivado: dono.is_active === false } } : {}),
    },
  };
}

module.exports = { ehBarcodeDuplicado, mensagemDoBarcodeDuplicado, respostaDeBarcodeDuplicado, CONSTRAINT };
