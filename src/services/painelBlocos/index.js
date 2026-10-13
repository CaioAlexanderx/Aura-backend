// ============================================================
// AURA. — Painel da Gestão Aura: catálogo de blocos
//
// Um bloco só entra aqui se o número se calcula sozinho. A ordem é a ordem
// padrão da tela (cada usuário reordena e esconde em /admin/painel/layout).
// `periodoPadrao` é a janela com que o job diário calcula e grava o bloco;
// GET /admin/painel/blocos/:id?periodo=7|30|90 recalcula ao vivo quando o
// período pedido é outro.
// ============================================================
'use strict';

const BLOCOS = [
  { id: 'trials_degrau', titulo: 'Trials por degrau', grupo: 'negocio', periodoPadrao: 30 },
  { id: 'receita', titulo: 'Receita', grupo: 'negocio', periodoPadrao: 30 },
  { id: 'cadastros', titulo: 'Cadastros', grupo: 'negocio', periodoPadrao: 30 },
  { id: 'pagantes', titulo: 'Pagantes', grupo: 'negocio', periodoPadrao: 30 },
  { id: 'pagantes_sem_venda', titulo: 'Pagantes sem venda', grupo: 'negocio', periodoPadrao: 7 },
  { id: 'acesso', titulo: 'Acesso', grupo: 'produto', periodoPadrao: 30 },
  { id: 'uso_funcionalidade', titulo: 'Uso por funcionalidade', grupo: 'produto', periodoPadrao: 30 },
  { id: 'horario', titulo: 'Horário de uso', grupo: 'produto', periodoPadrao: 30 },
  { id: 'plataforma', titulo: 'Plataforma', grupo: 'produto', periodoPadrao: 14 },
  { id: 'adocao', titulo: 'Adoção por recurso', grupo: 'produto', periodoPadrao: 30 },
  { id: 'telas_visitadas', titulo: 'Telas visitadas', grupo: 'produto', periodoPadrao: 30 },
  { id: 'fiscal', titulo: 'Fiscal', grupo: 'operacao', periodoPadrao: 7 },
  { id: 'crediario', titulo: 'Crediário', grupo: 'operacao', periodoPadrao: 30 },
  { id: 'contatos', titulo: 'Contatos', grupo: 'operacao', periodoPadrao: 30 },
  { id: 'frentes', titulo: 'Frentes', grupo: 'operacao', periodoPadrao: 30 },
].map((b) => ({ ...b, calcular: require(`./${b.id}`).calcular }));

const POR_ID = new Map(BLOCOS.map((b) => [b.id, b]));

const PERIODOS = [7, 30, 90];

module.exports = { BLOCOS, POR_ID, PERIODOS };
