// ============================================================
// AURA. — BE-03: Standardized Pagination Helper
// Usage: const result = await paginate(db, baseQuery, params, req);
// Returns: { rows, total, page, per_page, pages }
// ============================================================
const db = require('../config/database');

/**
 * Paginated query helper.
 * Reads `page` and `per_page` from req.query.
 * 
 * @param {string} baseQuery - SQL query WITHOUT LIMIT/OFFSET (e.g., 'SELECT * FROM products WHERE company_id=$1')
 * @param {Array} params - Query parameters for baseQuery
 * @param {object} req - Express request (reads req.query.page, req.query.per_page)
 * @param {object} opts - Options
 * @param {string} opts.countQuery - Custom count query (default: wraps baseQuery in COUNT(*))
 * @param {string} opts.orderBy - ORDER BY clause (default: 'created_at DESC')
 * @param {number} opts.defaultPerPage - Default items per page (default: 20)
 * @param {number} opts.maxPerPage - Max items per page (default: 100)
 * @returns {{ rows, total, page, per_page, pages, has_next, has_prev }}
 */
async function paginate(baseQuery, params, req, opts = {}) {
  const defaultPerPage = opts.defaultPerPage || 20;
  const maxPerPage = opts.maxPerPage || 100;
  const orderBy = opts.orderBy || 'created_at DESC';

  // Parse pagination params
  const page = Math.max(1, parseInt(req.query?.page) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, parseInt(req.query?.per_page || req.query?.limit) || defaultPerPage));
  const offset = (page - 1) * perPage;

  // Count total
  const countQuery = opts.countQuery || `SELECT COUNT(*) AS total FROM (${baseQuery}) AS _count`;
  const { rows: countRows } = await db.query(countQuery, params);
  const total = parseInt(countRows[0]?.total || countRows[0]?.count) || 0;

  // Fetch page
  const paginatedQuery = `${baseQuery} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const { rows } = await db.query(paginatedQuery, [...params, perPage, offset]);

  const pages = Math.ceil(total / perPage);

  return {
    rows,
    total,
    page,
    per_page: perPage,
    pages,
    has_next: page < pages,
    has_prev: page > 1,
  };
}

/**
 * Simple pagination metadata from an existing array.
 * Useful when data is already fetched.
 */
function paginateMeta(total, page, perPage) {
  const pages = Math.ceil(total / perPage);
  return { total, page, per_page: perPage, pages, has_next: page < pages, has_prev: page > 1 };
}

module.exports = { paginate, paginateMeta };
