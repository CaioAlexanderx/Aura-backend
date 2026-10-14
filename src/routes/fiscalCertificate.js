// ============================================================
// AURA. — Certificado A1 pelo próprio cliente (14/10/2026)
//
//   GET  /companies/:id/fiscal-certificate
//     → { cert: { subject_cn, not_before, not_after, days_left, updated_at } | null,
//         empresa_cnpj, pode_enviar }          (só metadados, nenhum segredo)
//   POST /companies/:id/fiscal-certificate   { pfx_base64, password }
//     → 201 { subject_cn, not_before, not_after, days_left }
//
// Mesmo formato da rota da equipe (POST /admin/aura-notas/:companyId/certificate):
// mesmo certStore (valida o .pfx — senha e validade — e cifra AES-256-GCM em
// company_certificates). Diferenças, por decisão do Caio (14/10/2026):
//   - só o DONO da empresa envia (companies.owner_id) — staff passa, para suporte;
//   - o CNPJ de dentro do certificado tem que ser o da empresa (conferido ANTES
//     de gravar; e-CPF e certificado sem CNPJ são recusados);
//   - mensagens amigáveis + `code` estável por tipo de erro;
//   - limite de tamanho do .pfx e freio de tentativas por empresa.
// A rota legada /nfe/certificate (Nuvem Fiscal) e a da equipe NÃO mudam.
//
// SEGREDOS: senha, base64 e conteúdo do .pfx nunca são logados, devolvidos em
// erro nem gravados na auditoria. Log só de `code` e do id curto da empresa.
//
// Auditoria: audit_log (mesmo mecanismo de routes/checkin.js, não o
// admin_audit_log da equipe). Falha de auditoria nunca derruba a rota.
//
// Parâmetros:
//   CERT_CNPJ_ACEITA_RAIZ=1  aceita e-CNPJ da matriz/filial do mesmo grupo
//                            (8 primeiros dígitos). Padrão: CNPJ idêntico.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const forge = require('node-forge');
const db = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const certStore = require('../services/sefazSp/certStore');
const { openPfx, assertValidity } = require('../services/sefazSp/pfx');
const { hasMasterKey } = require('../utils/secretCrypto');
const { daysLeft } = require('../services/auraNotas/gestao');
const { extrairCnpjDoCertificado, cnpjConfere, soDigitos } = require('../services/sefazSp/certCnpj');

const MAX_PFX_BYTES = 256 * 1024;                       // .pfx real tem 3–10 KB
const MAX_B64_CHARS = Math.ceil(MAX_PFX_BYTES / 3) * 4 + 8;
const TENTATIVAS_MAX = 5;
const JANELA_MS = 10 * 60 * 1000;

const MSG_ARQUIVO = 'Não conseguimos ler este arquivo. Envie o certificado digital A1 (arquivo .pfx ou .p12).';
const MSG_GRANDE = 'O arquivo é grande demais para ser um certificado A1. Confira se escolheu o arquivo .pfx certo.';

// ── freio de tentativas por empresa (em memória; 1 instância na Railway) ──
const tentativas = new Map(); // companyId -> number[] (timestamps)
function registrarTentativa(companyId, agora = Date.now()) {
  const recentes = (tentativas.get(companyId) || []).filter((t) => agora - t < JANELA_MS);
  if (recentes.length >= TENTATIVAS_MAX) {
    tentativas.set(companyId, recentes);
    return { ok: false, espera_s: Math.max(1, Math.ceil((JANELA_MS - (agora - recentes[0])) / 1000)) };
  }
  recentes.push(agora);
  tentativas.set(companyId, recentes);
  if (tentativas.size > 5000) { // higiene: descarta empresas sem tentativa recente
    for (const [k, v] of tentativas) if (!v.some((t) => agora - t < JANELA_MS)) tentativas.delete(k);
  }
  return { ok: true };
}

const ehStaff = (req) => !!req.user && (req.user.is_staff === true || req.user.role === 'admin');
const idCurto = (id) => String(id || '').slice(0, 8);

function falha(res, status, code, error, extra) {
  return res.status(status).json(Object.assign({ error, code }, extra || {}));
}

async function carregarEmpresa(companyId) {
  const { rows } = await db.query(
    `-- fiscalcert:empresa
     SELECT owner_id, cnpj FROM companies WHERE id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

async function auditar(req, companyId, action, detail, metadata) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user && req.user.id ? req.user.id : null, companyId, action, detail, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    // tabela ausente (42P01) ou qualquer outra: nunca derruba o envio.
    console.warn('[fiscal-cert] audit log falhou:', err && err.code ? err.code : 'erro');
  }
}

// Erros do openPfx/assertValidity → { status, code, error } amigável.
function classificarErroAbertura(err) {
  const msg = String((err && err.message) || '');
  if (/senha incorreta/i.test(msg)) {
    return { status: 400, code: 'CERT_SENHA_INCORRETA', error: 'A senha do certificado não confere. Confira a senha e tente de novo.' };
  }
  if (/expirado/i.test(msg)) {
    return { status: 422, code: 'CERT_VENCIDO', error: 'Este certificado está vencido. Envie um certificado dentro da validade.' };
  }
  if (/ainda não é válido/i.test(msg)) {
    return { status: 422, code: 'CERT_AINDA_NAO_VALIDO', error: 'Este certificado ainda não começou a valer. Envie um certificado dentro da validade.' };
  }
  return { status: 400, code: 'CERT_ARQUIVO_INVALIDO', error: MSG_ARQUIVO };
}

// ── GET / ─────────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const empresa = await carregarEmpresa(companyId);
  if (!empresa) return falha(res, 404, 'COMPANY_NOT_FOUND', 'Empresa não encontrada');

  let cert = null;
  try {
    const info = await certStore.getCertificateInfo(db, companyId);
    if (info) {
      cert = {
        subject_cn: info.subject_cn,
        not_before: info.not_before,
        not_after: info.not_after,
        days_left: daysLeft(info.not_after),
        updated_at: info.updated_at || null,
      };
    }
  } catch (err) {
    if (!err || err.code !== '42P01') throw err; // tabela ausente: sem certificado
  }

  const dono = !!empresa.owner_id && String(empresa.owner_id) === String(req.user.id);
  res.json({
    cert,
    empresa_cnpj: soDigitos(empresa.cnpj) || null,
    pode_enviar: dono || ehStaff(req),
  });
}));

// ── POST / ────────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;

  const empresa = await carregarEmpresa(companyId);
  if (!empresa) return falha(res, 404, 'COMPANY_NOT_FOUND', 'Empresa não encontrada');

  const staff = ehStaff(req);
  const dono = !!empresa.owner_id && String(empresa.owner_id) === String(req.user.id);
  if (!staff && !dono) {
    return falha(res, 403, 'APENAS_DONO', 'Só o dono da empresa pode enviar o certificado digital. Peça para ele fazer o envio.');
  }

  const { pfx_base64, password } = req.body || {};
  if (typeof pfx_base64 !== 'string' || !pfx_base64.trim()) {
    return falha(res, 400, 'CERT_ARQUIVO_OBRIGATORIO', 'Selecione o arquivo do certificado (.pfx).');
  }
  if (typeof password !== 'string' || !password) {
    return falha(res, 400, 'CERT_SENHA_OBRIGATORIA', 'Informe a senha do certificado.');
  }
  if (!hasMasterKey()) {
    return falha(res, 503, 'CERT_INDISPONIVEL', 'O envio de certificado está indisponível no momento. Fale com o suporte da Aura.');
  }

  const freio = registrarTentativa(companyId);
  if (!freio.ok) {
    res.set('Retry-After', String(freio.espera_s));
    return falha(res, 429, 'CERT_MUITAS_TENTATIVAS', 'Muitas tentativas de envio. Aguarde alguns minutos e tente de novo.', { retry_after_s: freio.espera_s });
  }

  // Tamanho: confere a string ANTES de decodificar (não aloca buffer gigante).
  const b64 = pfx_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (b64.length > MAX_B64_CHARS) {
    return falha(res, 413, 'CERT_GRANDE_DEMAIS', MSG_GRANDE);
  }
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return falha(res, 400, 'CERT_ARQUIVO_INVALIDO', MSG_ARQUIVO);
  }
  const pfxBuffer = Buffer.from(b64, 'base64');
  if (pfxBuffer.length === 0) {
    return falha(res, 400, 'CERT_ARQUIVO_INVALIDO', MSG_ARQUIVO);
  }
  if (pfxBuffer.length > MAX_PFX_BYTES) {
    return falha(res, 413, 'CERT_GRANDE_DEMAIS', MSG_GRANDE);
  }

  // Estrutura: se nem é DER, é arquivo errado (e não senha errada).
  try {
    forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
  } catch (_) {
    return falha(res, 400, 'CERT_ARQUIVO_INVALIDO', MSG_ARQUIVO);
  }

  // 1) abre e valida (senha, vigência) — nada é gravado ainda
  let info;
  try {
    info = openPfx(pfxBuffer, password);
    assertValidity(info);
  } catch (err) {
    const c = classificarErroAbertura(err);
    console.warn('[fiscal-cert] envio recusado:', c.code, idCurto(companyId));
    return falha(res, c.status, c.code, c.error);
  }

  // 2) o CNPJ do certificado tem que ser o da empresa
  const cnpjEmpresa = soDigitos(empresa.cnpj);
  if (cnpjEmpresa.length !== 14) {
    return falha(res, 422, 'EMPRESA_SEM_CNPJ', 'Cadastre o CNPJ da empresa antes de enviar o certificado.');
  }
  const doCert = extrairCnpjDoCertificado(info);
  if (!doCert) {
    console.warn('[fiscal-cert] envio recusado: CERT_SEM_CNPJ', idCurto(companyId));
    await auditar(req, companyId, 'fiscal.certificado_recusado', 'Certificado recusado: sem CNPJ', { code: 'CERT_SEM_CNPJ' });
    return falha(res, 422, 'CERT_SEM_CNPJ', 'Este certificado não é de empresa (e-CNPJ). Envie o certificado A1 do CNPJ da empresa.');
  }
  const aceitaRaiz = process.env.CERT_CNPJ_ACEITA_RAIZ === '1';
  if (!cnpjConfere(doCert.cnpj, cnpjEmpresa, aceitaRaiz)) {
    console.warn('[fiscal-cert] envio recusado: CERT_CNPJ_DIVERGENTE', idCurto(companyId));
    await auditar(req, companyId, 'fiscal.certificado_recusado', 'Certificado recusado: CNPJ diferente da empresa', { code: 'CERT_CNPJ_DIVERGENTE' });
    return falha(res, 422, 'CERT_CNPJ_DIVERGENTE', 'O CNPJ deste certificado é diferente do CNPJ da empresa. Envie o certificado da própria empresa.');
  }

  // 3) grava (certStore valida de novo e cifra AES-256-GCM)
  let salvo;
  try {
    salvo = await certStore.saveCertificate(db, companyId, pfxBuffer, password);
  } catch (err) {
    console.error('[fiscal-cert] erro ao gravar:', (err && err.code) || 'erro', idCurto(companyId));
    return falha(res, 500, 'CERT_ERRO_INTERNO', 'Não foi possível guardar o certificado agora. Tente novamente em instantes.');
  }

  const porStaff = staff && !dono;
  await auditar(req, companyId, 'fiscal.certificado_enviado',
    'Certificado A1 enviado ' + (porStaff ? 'pela equipe' : 'pelo dono'),
    { subject_cn: salvo.subject_cn, not_after: salvo.not_after, origem_cnpj: doCert.origem, por: porStaff ? 'staff' : 'dono' });

  res.status(201).json({
    subject_cn: salvo.subject_cn,
    not_before: salvo.not_before,
    not_after: salvo.not_after,
    days_left: daysLeft(salvo.not_after),
  });
}));

module.exports = router;
module.exports._testing = { registrarTentativa, tentativas, TENTATIVAS_MAX, JANELA_MS, MAX_PFX_BYTES };
