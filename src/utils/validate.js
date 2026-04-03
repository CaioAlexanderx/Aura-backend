// ============================================================
// AURA. — BE-02: Lightweight Input Validation
// No external dependency — pure JS schema validation
// Usage: router.post('/endpoint', validate(schema), handler)
// ============================================================

const TYPES = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && !isNaN(v),
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => v && typeof v === 'object' && !Array.isArray(v),
  uuid: v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  email: v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: v => typeof v === 'string' && v.replace(/\D/g, '').length >= 10,
  date: v => typeof v === 'string' && !isNaN(Date.parse(v)),
  cnpj: v => typeof v === 'string' && v.replace(/\D/g, '').length === 14,
  cpf: v => typeof v === 'string' && v.replace(/\D/g, '').length === 11,
};

/**
 * Validate request body against a schema.
 * @param {Object} schema - { fieldName: { type, required, min, max, enum, pattern, default, transform } }
 * @param {string} source - 'body' | 'query' | 'params'
 * 
 * Example schema:
 * {
 *   name:     { type: 'string', required: true, min: 1, max: 200 },
 *   email:    { type: 'email', required: true },
 *   price:    { type: 'number', required: true, min: 0 },
 *   category: { type: 'string', enum: ['produto', 'servico'] },
 *   phone:    { type: 'phone' },
 *   tags:     { type: 'array' },
 *   active:   { type: 'boolean', default: true },
 * }
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source] || {};
    const errors = [];
    const cleaned = {};

    for (const [field, rules] of Object.entries(schema)) {
      let value = data[field];

      // Apply default
      if (value === undefined && rules.default !== undefined) {
        value = typeof rules.default === 'function' ? rules.default() : rules.default;
      }

      // Required check
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} \u00e9 obrigat\u00f3rio`);
        continue;
      }

      // Skip optional missing fields
      if (value === undefined || value === null) {
        if (rules.nullable) cleaned[field] = null;
        continue;
      }

      // Transform before validation
      if (rules.transform) {
        value = rules.transform(value);
      }

      // Auto-coerce string numbers for 'number' type
      if (rules.type === 'number' && typeof value === 'string') {
        const parsed = parseFloat(value.replace(',', '.'));
        if (!isNaN(parsed)) value = parsed;
      }

      // Type check
      if (rules.type && TYPES[rules.type] && !TYPES[rules.type](value)) {
        errors.push(`${field} deve ser do tipo ${rules.type}`);
        continue;
      }

      // String validations
      if (typeof value === 'string') {
        if (rules.trim !== false) value = value.trim();
        if (rules.lowercase) value = value.toLowerCase();
        if (rules.min !== undefined && value.length < rules.min) {
          errors.push(`${field} deve ter pelo menos ${rules.min} caractere(s)`);
          continue;
        }
        if (rules.max !== undefined && value.length > rules.max) {
          errors.push(`${field} deve ter no m\u00e1ximo ${rules.max} caractere(s)`);
          continue;
        }
        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`${field} tem formato inv\u00e1lido`);
          continue;
        }
      }

      // Number validations
      if (typeof value === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          errors.push(`${field} deve ser pelo menos ${rules.min}`);
          continue;
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push(`${field} deve ser no m\u00e1ximo ${rules.max}`);
          continue;
        }
      }

      // Enum check
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`${field} deve ser um de: ${rules.enum.join(', ')}`);
        continue;
      }

      cleaned[field] = value;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors, field_count: errors.length });
    }

    // Attach cleaned data
    req.validated = cleaned;
    next();
  };
}

// ============================================================
// Pre-built schemas for common routes
// ============================================================

const schemas = {
  register: {
    name:         { type: 'string', required: true, min: 2, max: 200 },
    email:        { type: 'email', required: true, lowercase: true },
    password:     { type: 'string', required: true, min: 8, max: 100 },
    company_name: { type: 'string', required: true, min: 1, max: 200 },
    phone:        { type: 'phone' },
    cnpj:         { type: 'cnpj' },
    access_code:  { type: 'string', max: 50, transform: v => v ? v.toUpperCase().trim() : v },
  },

  login: {
    email:    { type: 'email', required: true, lowercase: true },
    password: { type: 'string', required: true, min: 1 },
  },

  createTransaction: {
    description: { type: 'string', required: true, min: 1, max: 500 },
    amount:      { type: 'number', required: true, min: 0.01 },
    type:        { type: 'string', required: true, enum: ['income', 'expense'] },
    category:    { type: 'string', max: 100 },
    date:        { type: 'date' },
  },

  createProduct: {
    name:           { type: 'string', required: true, min: 1, max: 200 },
    sku:            { type: 'string', max: 50 },
    price:          { type: 'number', required: true, min: 0 },
    cost_price:     { type: 'number', min: 0 },
    stock_quantity: { type: 'number', min: 0, default: 0 },
    min_stock:      { type: 'number', min: 0, default: 0 },
    category:       { type: 'string', max: 100 },
    barcode:        { type: 'string', max: 50 },
    unit:           { type: 'string', max: 10, default: 'un' },
  },

  createCustomer: {
    name:      { type: 'string', required: true, min: 1, max: 200 },
    email:     { type: 'email', lowercase: true },
    phone:     { type: 'phone' },
    instagram: { type: 'string', max: 60 },
    birthday:  { type: 'string', max: 10 },
    notes:     { type: 'string', max: 1000 },
  },

  createSale: {
    items:       { type: 'array', required: true },
    customer_id: { type: 'uuid' },
    payment_method: { type: 'string', enum: ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro', 'boleto', 'outro'] },
    discount:    { type: 'number', min: 0 },
  },

  aiChat: {
    message: { type: 'string', required: true, min: 1, max: 2000 },
    context: { type: 'string', enum: ['geral', 'financeiro', 'estoque', 'crm', 'contabil', 'marketing'], default: 'geral' },
    history: { type: 'array' },
  },
};

module.exports = { validate, schemas };
