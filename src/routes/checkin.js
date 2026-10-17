// ============================================================
// AURA. — Check-in do prospect: tela do cliente (14/10/2026)
//
//   GET /companies/:id/checkin
//     → { habilitado, respondido, pulou, versao: 1, respostas | null }
//   PUT /companies/:id/checkin   { comeco?, onde_anota?, produtos_faixa?, pulou? }
//     → { checkin }
//
// Contrato fixo com a tela do app (frente D): não renomear chaves.
//
// `habilitado` é o que o app lê para decidir se mostra a tela depois da
// escolha da frente: interruptor ligado (CHECKIN_ENABLED) E empresa criada a
// partir de CHECKIN_DESDE E sem resposta nem "pulou". Regras e parâmetros em
// services/checkin.js. Conta de staff (modo admin) nunca vê nem responde.
//
// Auditoria (audit_log): checkin.exibido (só na primeira vez que habilitado
// for true — o carimbo exibido_em no json impede repetir), checkin.respondido
// e checkin.pulou (uma vez cada). Falha de auditoria nunca derruba a rota.
//
// Montada em routes/private.js, atrás de requireAuth + requireCompanyAccess:
// qualquer membro da empresa. Migration 384 pendente (42703): GET responde
// habilitado: false (o app segue direto ao Painel) e PUT 503.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const checkin = require('../services/checkin');
const { avancarSemEsperar } = require('../services/onboardingProgress');

const FECHADO = { habilitado: false, respondido: false, pulou: false, versao: checkin.VERSAO, respostas: null };

// Leitura da empresa. Federação (sede e dojôs) e filial de dono antigo ficam de
// fora (services/checkin.sqlForaDoCheckin): as perguntas são de varejo e o
// check-in é do cadastro novo, não de cada CNPJ.
async function carregar(companyId) {
  const { rows } = await db.query(
    `-- checkin:empresa
     SELECT c.created_at, c.checkin,
            ${checkin.sqlForaDoCheckin('c')} AS fora
       FROM companies c
      WHERE c.id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

async function auditar(req, companyId, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user && req.user.id ? req.user.id : null, companyId, action, detail, JSON.stringify({ versao: checkin.VERSAO })]
    );
  } catch (err) {
    console.warn('[checkin] audit log falhou:', err.message);
  }
}

const ehStaff = (req) => !!req.user && req.user.role === 'admin';

router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  let empresa;
  try {
    empresa = await carregar(companyId);
  } catch (err) {
    if (err && err.code === '42703') return res.json(FECHADO);
    throw err;
  }
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada', code: 'COMPANY_NOT_FOUND' });

  const out = checkin.estado({ empresa, config: checkin.configuracao(), staff: ehStaff(req) });

  // Primeira vez que a tela é oferecida: carimba exibido_em (condicional, então
  // duas chamadas juntas gravam uma só) e só então registra o evento.
  if (out.habilitado) {
    try {
      const { rowCount } = await db.query(
        `-- checkin:exibido
         UPDATE companies
            SET checkin = COALESCE(checkin, '{}'::jsonb) || jsonb_build_object('exibido_em', $2::text)
          WHERE id = $1 AND (checkin IS NULL OR NOT (checkin ? 'exibido_em'))`,
        [companyId, new Date().toISOString()]
      );
      if (rowCount > 0) await auditar(req, companyId, 'checkin.exibido', 'Check-in exibido');
    } catch (err) {
      console.warn('[checkin] carimbo de exibição falhou:', err.message);
    }
  }
  res.json(out);
}));

router.put('/', asyncHandler(async (req, res) => {
  if (ehStaff(req)) {
    return res.status(403).json({ error: 'O check-in é respondido pelo cliente.', code: 'CHECKIN_STAFF' });
  }
  const { erro, patch, semEfeito } = checkin.normalizarPut(req.body);
  if (erro) return res.status(400).json({ error: erro, code: 'CHECKIN_INVALID' });

  const companyId = req.params.id;
  let empresa;
  try {
    empresa = await carregar(companyId);
  } catch (err) {
    if (err && err.code === '42703') {
      return res.status(503).json({ error: 'Check-in indisponível (migration 384 pendente).', code: 'MIGRATION_PENDING' });
    }
    throw err;
  }
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada', code: 'COMPANY_NOT_FOUND' });

  // `{ pulou: false }` sozinho: 200 sem mexer em nada (não carimba, não fecha).
  if (semEfeito) {
    return res.json({ checkin: empresa.checkin && typeof empresa.checkin === 'object' ? empresa.checkin : {} });
  }

  const agora = new Date();
  const { checkin: depois, eventos } = checkin.aplicar(empresa.checkin, patch, agora);

  // Grava só o que mudou (merge no banco): duas respostas que chegam juntas,
  // cada uma com a sua chave, não se sobrescrevem.
  const antes = empresa.checkin && typeof empresa.checkin === 'object' ? empresa.checkin : {};
  const delta = {};
  for (const k of Object.keys(depois)) if (depois[k] !== antes[k]) delta[k] = depois[k];

  let gravado = depois;
  if (Object.keys(delta).length) {
    const { rows } = await db.query(
      `-- checkin:gravar
       UPDATE companies
          SET checkin = COALESCE(checkin, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
        RETURNING checkin`,
      [companyId, JSON.stringify(delta)]
    );
    if (rows[0] && rows[0].checkin) gravado = rows[0].checkin;
  }

  for (const ev of eventos) {
    await auditar(req, companyId, ev, ev === 'checkin.pulou' ? 'Check-in pulado' : 'Check-in respondido');
  }
  // 17/10/2026 (t2-04): check-in respondido ou pulado = cadastro concluído
  // (último passo antes do Painel). Avança onboarding_step para 'perfil'.
  if (eventos.includes('checkin.respondido') || eventos.includes('checkin.pulou')) {
    avancarSemEsperar(companyId, 'perfil');
  }
  res.json({ checkin: gravado });
}));

module.exports = router;
