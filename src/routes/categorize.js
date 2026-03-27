// ============================================================
// AURA. — CORE-04: Categorização Automática via IA
// Usa Claude Haiku (anthropic API) para sugerir categorias
// para lançamentos sem categoria — OFX, manual, batch
//
// Endpoints:
//   POST /companies/:id/transactions/categorize
//     Body: { descriptions: ['Aluguel sala comercial', 'Energia eletrica', ...] }
//     Retorna: [{ description, suggested_category, confidence, type_hint }]
//
//   POST /companies/:id/transactions/:txId/categorize
//     Categoriza e salva um lançamento específico
// ============================================================
const router  = require('express').Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// Categorias válidas da Aura (espelhando dre.js DEFAULT_LINE_MAP)
const AURA_CATEGORIES = [
  'venda', 'servico', 'servico_pj', 'receita_diversa',
  'imposto', 'das', 'compra_produto', 'estoque', 'mercadoria',
  'folha', 'salario', 'prolabore', 'inss', 'fgts',
  'aluguel', 'energia', 'internet', 'telefone', 'seguro', 'assinatura',
  'marketing', 'comissao', 'frete', 'manutencao', 'fornecedor',
  'juros', 'emprestimo', 'tarifa', 'outros',
];

// ── Chamada ao Claude Haiku via Anthropic API ───────────────
async function categorizeWithHaiku(descriptions) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sem chave configurada: retornar sugestões neutras (graceful degradation)
    return descriptions.map(d => ({
      description: d,
      suggested_category: 'outros',
      confidence: 'low',
      type_hint: null,
      fallback: true,
    }));
  }

  const categoriasList = AURA_CATEGORIES.join(', ');
  const lines = descriptions.map((d, i) => `${i + 1}. "${d}"`).join('\n');

  const prompt = `Você é um assistente de categorização financeira para pequenas empresas brasileiras.
Categorize cada descrição de lançamento bancário abaixo usando EXATAMENTE uma das categorias da lista.

Categorias disponíveis: ${categoriasList}

Lançamentos:
${lines}

Responda SOMENTE com um JSON válido no formato:
[
  {"index": 1, "category": "aluguel", "confidence": "high", "type": "expense"},
  ...
]

Regras:
- confidence: "high" (certeza), "medium" (provável), "low" (incerto)
- type: "income" ou "expense"
- Use "outros" apenas se não couber em nenhuma categoria
- Não inclua texto fora do JSON`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    // Extrair JSON da resposta (pode ter texto ao redor em casos extremos)
    const jsonMatch = text.match(/\[\s*[\s\S]*\]/m);
    const results = JSON.parse(jsonMatch ? jsonMatch[0] : text);

    // Mapear resultado de volta para descrições
    return descriptions.map((d, i) => {
      const result = results.find(r => r.index === i + 1);
      return {
        description: d,
        suggested_category: result?.category || 'outros',
        confidence: result?.confidence || 'low',
        type_hint: result?.type || null,
      };
    });
  } catch (err) {
    console.error('[categorize] Haiku error:', err.message);
    // Fallback gracioso em caso de erro
    return descriptions.map(d => ({
      description: d,
      suggested_category: 'outros',
      confidence: 'low',
      type_hint: null,
      fallback: true,
    }));
  }
}

// ──────────────────────────────────────────────────────
// POST /companies/:id/transactions/categorize
// Categoriza um lote de descrições sem salvar no banco
// Usado pelo front antes de confirmar a importação OFX
// Body: { descriptions: string[] } (máx 50)
// ──────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { descriptions } = req.body;

  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    return res.status(400).json({ error: 'descriptions deve ser um array não-vazio' });
  }
  if (descriptions.length > 50) {
    return res.status(400).json({ error: 'Máximo de 50 descrições por vez' });
  }

  const clean = descriptions.map(d => String(d).trim().substring(0, 200));
  const results = await categorizeWithHaiku(clean);

  res.json({
    note: 'Sugestões geradas por IA — revise antes de confirmar',
    categorized: results,
    available_categories: AURA_CATEGORIES,
  });
});

// ── POST /companies/:id/transactions/:txId/categorize
// Categoriza e aplica a categoria num lançamento já salvo
// útil para recategorizar lançamentos sem categoria
router.post('/:txId/categorize', requireAuth, async (req, res) => {
  const { id: companyId, txId } = req.params;
  const { apply = false } = req.body; // true = salva automaticamente

  try {
    // Busca o lançamento
    const { rows } = await db.query(
      `SELECT id, description, category FROM transactions WHERE id=$1 AND company_id=$2`,
      [txId, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lançamento não encontrado' });

    const tx = rows[0];
    const [result] = await categorizeWithHaiku([tx.description]);

    // Aplica automaticamente se solicitado
    if (apply) {
      await db.query(
        `UPDATE transactions SET category=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`,
        [result.suggested_category, txId, companyId]
      );
    }

    res.json({
      transaction_id: txId,
      description: tx.description,
      current_category: tx.category,
      suggestion: result,
      applied: apply,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exportar função para uso interno (OFX import)
module.exports = router;
module.exports.categorizeWithHaiku = categorizeWithHaiku;
