// ============================================================
// AURA. — Painel da Gestão Aura: uso por módulo
//
// Não existe evento de uso por funcionalidade: o uso é inferido pela tabela
// que cada módulo grava. Uma consulta por fonte (e não um UNION só) para
// uma tabela ausente zerar o módulo dela, não o bloco inteiro.
//
// Telas só de leitura (Relatórios, Painel) não gravam nada e ficam invisíveis
// aqui — é o que o bloco "Telas visitadas" cobre.
//
// 18/10/2026 (card t3-01): entram Ótica, Entregas e Parceiros do Matcon,
// Agenda e Cupons. Um módulo pode ter mais de uma fonte (`fontes`): a loja
// conta uma vez, os eventos somam. Etiquetas segue SEM medida (SEM_MEDIDA):
// imprimir é um GET que não grava nada, e o único rastro (a calibração em
// companies.pdv_settings) não tem data — não dá para contar uso em 30 dias.
// ============================================================
'use strict';

const b = require('./_base');

// tabela, coluna e filtro são constantes deste arquivo, nunca entrada de
// usuário. `filtro` é um trecho SQL sem alias, acrescentado com AND.
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
  // ── t3-01 ──
  // OS de ótica (kind = 'otica', migration 334) e receita lançada para o cliente.
  {
    id: 'otica', rotulo: 'Ótica',
    fontes: [
      { tabela: 'service_orders', coluna: 'created_at', filtro: `kind = 'otica'` },
      { tabela: 'optical_prescriptions', coluna: 'created_at' },
    ],
  },
  { id: 'entregas_matcon', rotulo: 'Entregas Matcon', tabela: 'matcon_deliveries', coluna: 'created_at' },
  // Parceiro cadastrado + movimento de pontos (venda indicada, resgate, ajuste).
  {
    id: 'parceiros_matcon', rotulo: 'Parceiros Matcon',
    fontes: [
      { tabela: 'matcon_professionals', coluna: 'created_at' },
      { tabela: 'matcon_professional_points_ledger', coluna: 'created_at' },
    ],
  },
  // Agenda do Negócio (barbearia/salão) e agenda da clínica odontológica.
  {
    id: 'agenda', rotulo: 'Agenda',
    fontes: [
      { tabela: 'barbershop_appointments', coluna: 'created_at' },
      { tabela: 'dental_appointments', coluna: 'created_at' },
    ],
  },
  // Cupom de desconto aplicado numa venda do Caixa (sales.coupon_id). Cupom
  // criado não entra: aniversário, crediário e Matcon geram cupom sozinhos.
  { id: 'cupons', rotulo: 'Cupons', tabela: 'sales', coluna: 'created_at', filtro: 'coupon_id IS NOT NULL' },
];

// Funcionalidades que o bloco lista mas NÃO consegue medir (sem fonte no banco).
const SEM_MEDIDA = [
  {
    id: 'etiquetas', rotulo: 'Etiquetas',
    motivo: 'imprimir etiqueta não grava nada no banco (só a calibração, sem data)',
  },
];

const EM_PARALELO = 4;

const fontesDe = (m) => m.fontes || [{ tabela: m.tabela, coluna: m.coluna, filtro: m.filtro }];

// Para cada módulo: Map company_id → { e7, ep, total, ultimo }.
// `ep` = eventos na janela `periodo`. Com companyId, só aquela loja.
async function usoPorModulo({ db = b.pool, hoje, periodo = 30, companyId = null }) {
  const params = companyId ? [hoje, companyId] : [hoje];

  const umaFonte = async (f) => {
    const rows = await b.opcional(
      db,
      `SELECT company_id,
              COUNT(*) FILTER (WHERE ${f.coluna} >= ${b.desde(7)}) AS e7,
              COUNT(*) FILTER (WHERE ${f.coluna} >= ${b.desde(periodo)}) AS ep,
              COUNT(*) AS total,
              MAX(${f.coluna}) AS ultimo
         FROM ${f.tabela}
        WHERE company_id IS NOT NULL${f.filtro ? ` AND ${f.filtro}` : ''}${companyId ? ' AND company_id = $2' : ''}
        GROUP BY company_id`,
      params
    );
    return rows;
  };

  const umModulo = async (m) => {
    const lojas = new Map();
    for (const fonte of fontesDe(m)) {
      for (const r of await umaFonte(fonte)) {
        const novo = { e7: b.num(r.e7), ep: b.num(r.ep), total: b.num(r.total), ultimo: r.ultimo };
        const atual = lojas.get(r.company_id);
        if (!atual) { lojas.set(r.company_id, novo); continue; }
        atual.e7 += novo.e7;
        atual.ep += novo.ep;
        atual.total += novo.total;
        if (novo.ultimo && (!atual.ultimo || new Date(novo.ultimo) > new Date(atual.ultimo))) atual.ultimo = novo.ultimo;
      }
    }
    return { id: m.id, rotulo: m.rotulo, lojas };
  };

  const out = [];
  for (let i = 0; i < MODULOS.length; i += EM_PARALELO) {
    out.push(...await Promise.all(MODULOS.slice(i, i + EM_PARALELO).map(umModulo)));
  }
  return out;
}

module.exports = { MODULOS, SEM_MEDIDA, usoPorModulo };
