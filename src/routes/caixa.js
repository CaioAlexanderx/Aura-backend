// ============================================================
// AURA. — Módulo de Caixa
//
// GET  /companies/:id/caixa/status          — status ao vivo
// GET  /companies/:id/caixa/operadores      — pessoas autorizadas a operar
// POST /companies/:id/caixa/abrir           — abrir sessão
// POST /companies/:id/caixa/fechar          — fechar sessão
// GET  /companies/:id/caixa/historico       — sessões fechadas
// GET  /companies/:id/caixa/sessao/:sessaoId — detalhe de uma sessão
//
// Pré-requisito: caixa habilitado em pdv_settings.caixa_enabled = true
//
// 07/05/2026: /abrir aceita responsavel_employee_id (opcional).
// /fechar passou a retornar metricas extras (sales_count,
// new_customers_count, sessao_label, closed_at) pro PDF de
// fechamento do aura-app.
// 07/05/2026 (hotfix): /fechar aceita observacao null (frontend
// manda null quando o campo esta vazio).
// 08/05/2026 (bug Davi Villa Branca):
//   GET /operadores — uniao de empregados ativos + membros ativos
//   com acesso a PDV. Cobre o caso multi-CNPJ onde o owner e/ou
//   funcionarios da filial nao tem entrada em `employees` (so estao
//   em `company_members`). Antes desse fix, o modal de Abrir Caixa
//   ficava com a lista vazia e bloqueava o fluxo.
//   POST /abrir aceita responsavel_user_id como alternativa a
//   responsavel_employee_id. Se o usuario tiver um employees row
//   vinculado, o backend resolve pra employee_id (mantendo o JOIN
//   antigo no historico/PDF). Senao, opened_by_employee_id fica
//   null e o display cai pro u.full_name via COALESCE existente.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const caixaService = require('../services/caixaService');

// ── GET /caixa/status ─────────────────────────────────────────────────────
// Retorna a sessão aberta atual com totais ao vivo, ou { sessao_ativa: null }.
router.get('/status', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const result = await caixaService.getStatus(companyId);
  res.json(result);
}));

// ── GET /caixa/operadores ─────────────────────────────────────────────────
// Lista pessoas autorizadas a abrir caixa nesta empresa.
//
// Combina duas fontes:
//   1) employees ativos (legado — funcionarios com CPF cadastrado em Equipe).
//   2) company_members ativos com acesso a PDV (owner/admin sempre tem;
//      colaboradores precisam de permissions.pdv === true).
//
// Sem deduplicacao explicita por usuario — se um membro tambem tem entrada
// em employees, aparece duas vezes (uma como source='employee' com
// employee_id e outra como source='member' com user_id). O frontend pode
// dedupe por nome/cpf se quiser; pra Davi/Mariana isso nao acontece porque
// nem Davi (dono) nem Marina (atendente da Villa Branca) tem entrada em
// employees pra Villa Branca.
//
// Response: { operadores: Array<{
//   key:         string;          // id estavel pro <ListItem key={...}>
//   id:          string;          // employee_id quando source='employee', user_id quando 'member'
//   name:        string;
//   role:        string|null;
//   source:      'employee'|'member';
//   employee_id: string|null;     // preenchido quando source='employee'
//   user_id:     string|null;     // preenchido quando source='member' (e quando employee tem user_id vinculado)
// }> }
router.get('/operadores', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const db = require('../config/database');

  // Fonte 1: employees ativos
  const { rows: emps } = await db.query(
    `SELECT id, name, role, role_title, user_id
       FROM employees
      WHERE company_id = $1
        AND is_active = true
      ORDER BY name ASC`,
    [companyId]
  );

  const fromEmployees = emps.map(e => ({
    key:         'emp:' + e.id,
    id:          e.id,
    name:        e.name || 'Sem nome',
    role:        e.role || e.role_title || null,
    source:      'employee',
    employee_id: e.id,
    user_id:     e.user_id || null,
  }));

  // Fonte 2: members ativos com acesso a PDV.
  // owner/admin sempre podem; outros precisam de permissions.pdv === true.
  // Filtra m.user_id NOT NULL — convites pendentes (sem user_id) nao podem
  // operar caixa. status='active' AND is_active=true ja exclui suspended.
  const { rows: members } = await db.query(
    `SELECT m.user_id,
            m.role_label,
            m.permissions,
            u.full_name
       FROM company_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.company_id = $1
        AND m.status = 'active'
        AND m.is_active = true
        AND m.user_id IS NOT NULL
        AND (
          m.role_label IN ('owner', 'admin')
          OR (m.permissions->>'pdv')::boolean IS TRUE
        )
      ORDER BY u.full_name ASC`,
    [companyId]
  );

  const fromMembers = members.map(m => ({
    key:         'mem:' + m.user_id,
    id:          m.user_id,
    name:        m.full_name || 'Sem nome',
    role:        m.role_label || null,
    source:      'member',
    employee_id: null,
    user_id:     m.user_id,
  }));

  // Merge — dedupe por user_id (quando um employee tem user_id vinculado e
  // ja aparece via members, mantemos so a entrada de employees pra preservar
  // o employee_id pro INSERT em opened_by_employee_id).
  const empUserIds = new Set(fromEmployees.map(e => e.user_id).filter(Boolean));
  const membersFiltered = fromMembers.filter(m => !empUserIds.has(m.user_id));

  const operadores = [...fromEmployees, ...membersFiltered].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'pt-BR')
  );

  res.json({ operadores });
}));

// ── POST /caixa/abrir ─────────────────────────────────────────────────────
// Body: {
//   troco_inicial?: number,
//   responsavel_employee_id?: string,   // employee_id (compat antigo)
//   responsavel_user_id?: string        // alternativa pra membros sem employee row
// }
// Abre nova sessão. Rejeita com 409 se já há uma sessão aberta.
//
// Quando responsavel_user_id é informado, o backend tenta mapear pra um
// employee_id via employees.user_id; se encontrar, usa employee_id no
// FK opened_by_employee_id. Se nao houver employee correspondente,
// opened_by_employee_id fica null — o COALESCE no SELECT (e.name, u.full_name)
// usa o nome do usuario autenticado pra exibicao, que e a leitura correta
// quando o proprio operador abre o seu caixa (caso comum: Davi/Marina logam
// e abrem o caixa do CNPJ deles).
router.post('/abrir', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const userId    = req.user.id;
  const {
    troco_inicial = 0,
    responsavel_employee_id = null,
    responsavel_user_id = null,
  } = req.body || {};

  if (typeof troco_inicial !== 'number' || troco_inicial < 0) {
    throw new AppError('troco_inicial deve ser um número >= 0', 400);
  }
  if (responsavel_employee_id !== null && responsavel_employee_id !== undefined) {
    if (typeof responsavel_employee_id !== 'string' || responsavel_employee_id.length === 0) {
      throw new AppError('responsavel_employee_id deve ser uma string UUID', 400);
    }
  }
  if (responsavel_user_id !== null && responsavel_user_id !== undefined) {
    if (typeof responsavel_user_id !== 'string' || responsavel_user_id.length === 0) {
      throw new AppError('responsavel_user_id deve ser uma string UUID', 400);
    }
  }

  // Resolve employee_id final. Prioridade:
  //   1) responsavel_employee_id explicito (compat antigo).
  //   2) responsavel_user_id -> map para employees.user_id da company.
  //   3) null (caira no fallback de display via opened_by/users).
  let employeeIdFinal = responsavel_employee_id || null;
  if (!employeeIdFinal && responsavel_user_id) {
    const db = require('../config/database');
    const { rows } = await db.query(
      `SELECT id FROM employees
        WHERE company_id = $1 AND user_id = $2 AND is_active = true
        LIMIT 1`,
      [companyId, responsavel_user_id]
    );
    if (rows.length) employeeIdFinal = rows[0].id;
  }

  const sessao = await caixaService.abrir(
    companyId,
    userId,
    troco_inicial,
    employeeIdFinal
  );
  res.status(201).json({ sessao });
}));

// ── POST /caixa/fechar ────────────────────────────────────────────────────
// Body: { dinheiro_contado: number, observacao?: string | null }
// Fecha a sessão aberta. Cria o snapshot em caixa_fechamentos e retorna
// metricas extras (sales_count, new_customers_count, sessao_label, closed_at).
router.post('/fechar', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const userId    = req.user.id;
  const { dinheiro_contado, observacao } = req.body || {};

  if (dinheiro_contado === undefined || dinheiro_contado === null) {
    throw new AppError('dinheiro_contado é obrigatório', 400);
  }
  if (typeof dinheiro_contado !== 'number' || dinheiro_contado < 0) {
    throw new AppError('dinheiro_contado deve ser um número >= 0', 400);
  }
  // observacao pode ser undefined (omitida) OU null (campo vazio enviado pelo
  // frontend) OU string (campo preenchido). typeof null === 'object', por isso
  // checamos null explicitamente antes do typeof.
  if (
    observacao !== undefined &&
    observacao !== null &&
    typeof observacao !== 'string'
  ) {
    throw new AppError('observacao deve ser uma string', 400);
  }

  const fechamento = await caixaService.fechar(
    companyId,
    userId,
    dinheiro_contado,
    observacao || null
  );

  res.json({ fechamento });
}));

// ── GET /caixa/historico ──────────────────────────────────────────────────
// Query params: limit, offset, de (ISO date), ate (ISO date)
router.get('/historico', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);
  const de  = req.query.de  || null;
  const ate = req.query.ate || null;

  const result = await caixaService.getHistorico(companyId, { limit, offset, de, ate });
  res.json(result);
}));

// ── GET /caixa/sessao/:sessaoId ───────────────────────────────────────────
// Detalhe de uma sessão específica (aberta ou fechada).
router.get('/sessao/:sessaoId', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const sessaoId  = req.params.sessaoId;

  const sessao = await caixaService.getSessao(companyId, sessaoId);
  res.json({ sessao });
}));

module.exports = router;
