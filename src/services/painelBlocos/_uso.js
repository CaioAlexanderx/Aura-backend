// ============================================================
// AURA. — Painel da Gestão Aura: uso por módulo
//
// Não existe evento de uso por funcionalidade: o uso é inferido pela tabela
// que cada módulo grava. Uma consulta por módulo (e não um UNION só) para
// uma tabela ausente zerar o módulo dela, não o bloco inteiro.
//
// Telas só de leitura (Relatórios, Painel, Etiquetas) não gravam nada e
// ficam invisíveis aqui — é o que o bloco "Telas visitadas" cobre.
// ============================================================
'use strict';

const b = require('./_base');

// tabela e coluna são constantes deste arquivo, nunca entrada de usuário.
const MODULOS = [
  { id: 'caixa', rotulo: 'Caixa', tabela: 'sales', coluna: 'created_at' },
  { id: 'estoque', rotulo: 'Estoque', tabela: 'products', coluna: 'updated_at' },
  { id: 'clientes', rotulo: 'Clientes', tabela: 'customers', coluna: 'created_at' },
  { id: 'crediario', rotulo: 'Crediário', tabela: 'customer_credit_transactions', coluna: 'created_at' },
  { id: 'abertura_caixa', rotulo: 'Abertura de caixa', tabela: 'caixa_sessoes', coluna: 'opened_at' },
  { id: 'importacao', rotulo: 'Importação', tabela: 'import_logs', coluna: 'created_at' },
  { id: 'aura_notas', rotulo: 'Aura Notas', tabela: 'nfce_emissions', coluna: 'created_at' },
  { id: 'ordens_servico', rotulo: 'Ordens de serviço', tabela: 'service_orders', coluna: 'created_at' },
  { id: 'orcamentos_matcon', rotulo: 'Orçamentos Matcon', tabela: 'matcon_quotes', coluna: 'created_at' },
  { id: 'compras_matcon', rotulo: 'Compras Matcon', tabela: 'matcon_purchase_orders', coluna: 'created_at' },
  { id: 'studio_orcamentos', rotulo: 'Studio orçamentos', tabela: 'studio_quotes', coluna: 'created_at' },
  { id: 'studio_pedidos', rotulo: 'Studio pedidos', tabela: 'studio_orders', coluna: 'created_at' },
  { id: 'vitrine', rotulo: 'Vitrine', tabela: 'digital_orders', coluna: 'created_at' },
  { id: 'relatorios_email', rotulo: 'Relatórios por e-mail', tabela: 'report_deliveries', coluna: 'created_at' },
  { id: 'aurinha', rotulo: 'Aurinha (IA)', tabela: 'ai_usage_log', coluna: 'created_at' },
  { id: 'whatsapp', rotulo: 'WhatsApp', tabela: 'wa_messages', coluna: 'created_at' },
];

const EM_PARALELO = 4;

// Para cada módulo: Map company_id → { e7, ep, total, ultimo }.
// `ep` = eventos na janela `periodo`. Com companyId, só aquela loja.
async function usoPorModulo({ db = b.pool, hoje, periodo = 30, companyId = null }) {
  const params = companyId ? [hoje, companyId] : [hoje];
  const umModulo = async (m) => {
    const rows = await b.opcional(
      db,
      `SELECT company_id,
              COUNT(*) FILTER (WHERE ${m.coluna} >= ${b.desde(7)}) AS e7,
              COUNT(*) FILTER (WHERE ${m.coluna} >= ${b.desde(periodo)}) AS ep,
              COUNT(*) AS total,
              MAX(${m.coluna}) AS ultimo
         FROM ${m.tabela}
        WHERE company_id IS NOT NULL${companyId ? ' AND company_id = $2' : ''}
        GROUP BY company_id`,
      params
    );
    return {
      ...m,
      lojas: new Map(rows.map((r) => [r.company_id, {
        e7: b.num(r.e7), ep: b.num(r.ep), total: b.num(r.total), ultimo: r.ultimo,
      }])),
    };
  };

  const out = [];
  for (let i = 0; i < MODULOS.length; i += EM_PARALELO) {
    out.push(...await Promise.all(MODULOS.slice(i, i + EM_PARALELO).map(umModulo)));
  }
  return out;
}

module.exports = { MODULOS, usoPorModulo };
