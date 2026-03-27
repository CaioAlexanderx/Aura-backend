// ============================================================
// AURA. — Serviço de Avaliações (BE-06)
// Regra inviolável: link enviado para TODOS os clientes
// independente de nota esperada — sem review gating
// ============================================================

const db = require('../config/database');
const crypto = require('crypto');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();

/**
 * Gera token único para link de avaliação
 */
function generateReviewToken(saleId, companyId) {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`${saleId}-${companyId}-${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Cria registro de avaliação pendente e retorna links
 * Chamado ao concluir venda no PDV
 */
async function createReviewRequest(companyId, saleId, customerId) {
  // Buscar dados da empresa (Google URL)
  const { rows: companyRows } = await db.query(`
    SELECT trade_name, legal_name, website
    FROM companies
    WHERE id = $1
  `, [companyId]);

  if (!companyRows.length) {
    throw new Error('Empresa não encontrada');
  }

  const token = generateReviewToken(saleId, companyId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Inserir avaliação pendente
  const { rows } = await db.query(`
    INSERT INTO purchase_reviews
      (company_id, sale_id, customer_id, rating, sent_to_google, review_token, token_expires_at)
    VALUES ($1, $2, $3, NULL, false, $4, $5)
    RETURNING id
  `, [companyId, saleId, customerId, token, expiresAt]);

  const reviewId = rows[0].id;

  // URL base da Aura
  const baseUrl = env.APP_URL;

  return {
    review_id: reviewId,
    token,
    expires_at: expiresAt,
    // Link avaliação interna Aura
    review_url: `${baseUrl}/r/${token}`,
    // Link Google — empresa cadastra a URL do perfil GMB nas configurações
    google_url: null,
    // Mensagem WhatsApp pré-formatada
    whatsapp_message: buildWhatsAppMessage(companyRows[0], baseUrl, token),
  };
}

/**
 * Registrar resposta da avaliação (público — via link)
 */
async function submitReview(token, data) {
  const { rating, comment } = data;

  if (!rating || rating < 1 || rating > 5) {
    throw new Error('Nota deve ser entre 1 e 5');
  }

  // Buscar avaliação pelo token
  const { rows } = await db.query(`
    SELECT id, company_id, token_expires_at, rating
    FROM purchase_reviews
    WHERE review_token = $1
  `, [token]);

  if (!rows.length) {
    throw new Error('Link de avaliação inválido');
  }

  const review = rows[0];

  if (new Date() > new Date(review.token_expires_at)) {
    throw new Error('Link de avaliação expirado');
  }

  if (review.rating !== null) {
    throw new Error('Avaliação já respondida');
  }

  // Registrar avaliação — SEMPRE independente da nota
  const { rows: updated } = await db.query(`
    UPDATE purchase_reviews
    SET rating = $1, comment = $2, responded_at = NOW()
    WHERE review_token = $3
    RETURNING id, rating, company_id
  `, [rating, comment || null, token]);

  return {
    success: true,
    review_id: updated[0].id,
    rating: updated[0].rating,
    // Sempre retorna flag para redirecionar ao Google
    redirect_to_google: true,
  };
}

/**
 * Listar avaliações da empresa com filtros
 */
async function getReviews(companyId, options = {}) {
  const { rating, limit = 50, offset = 0 } = options;

  const params = [companyId];
  const filters = [];

  if (rating) {
    params.push(rating);
    filters.push(`r.rating = $${params.length}`);
  }

  const whereClause = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const { rows } = await db.query(`
    SELECT
      r.id,
      r.rating,
      r.comment,
      r.responded_at,
      r.sent_to_google,
      r.created_at,
      c.name AS customer_name,
      c.phone AS customer_phone,
      s.total_amount AS sale_amount
    FROM purchase_reviews r
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN sales s ON s.id = r.sale_id
    WHERE r.company_id = $1
      AND r.rating IS NOT NULL
      ${whereClause}
    ORDER BY r.responded_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  // Métricas agregadas
  const { rows: stats } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      ROUND(AVG(rating)::numeric, 1) AS avg_rating,
      COUNT(CASE WHEN rating = 5 THEN 1 END)::int AS five_star,
      COUNT(CASE WHEN rating = 4 THEN 1 END)::int AS four_star,
      COUNT(CASE WHEN rating = 3 THEN 1 END)::int AS three_star,
      COUNT(CASE WHEN rating = 2 THEN 1 END)::int AS two_star,
      COUNT(CASE WHEN rating = 1 THEN 1 END)::int AS one_star
    FROM purchase_reviews
    WHERE company_id = $1
      AND rating IS NOT NULL
  `, [companyId]);

  return {
    stats: stats[0],
    reviews: rows,
  };
}

/**
 * Monta mensagem WhatsApp com os dois links separados
 */
function buildWhatsAppMessage(company, baseUrl, token) {
  const name = company.trade_name || company.legal_name;

  return encodeURIComponent(
    `Olá! Obrigado por comprar na ${name} 😊\n\n` +
    `Sua opinião é muito importante para nós!\n\n` +
    `⭐ Avalie sua compra:\n${baseUrl}/r/${token}\n\n` +
    `📍 Nos avalie no Google:\n(link configurado nas preferências da empresa)`
  );
}

module.exports = {
  createReviewRequest,
  submitReview,
  getReviews,
};
