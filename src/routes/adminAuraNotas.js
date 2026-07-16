// ============================================================
// AURA. — Aura Notas / Gestão fiscal (STAFF) — "Gestão Aura"
// Mounted at: /api/v1/admin/aura-notas   (staff-only)
//
// Substitui o painel externo da Nuvem Fiscal: a equipe da Aura cadastra e
// monitora, por empresa, os dados fiscais + CSC + certificado A1 + status da
// engine própria de NFC-e ("Aura Notas"), que é o provedor PRIMÁRIO e OCULTO
// (modo AUTO em routes/nfce.js: engine quando a empresa tem A1 vigente + CSC,
// senão fallback pra Nuvem Fiscal).
//
// Staff-gate: requireAuth + requireStaff (req.user.is_staff === true) —
// mesmo sinal que routes/smartAlerts.js usa pra só mostrar o alerta de
// fallback do Aura Notas à equipe. Montado sob /admin (Central de Comando).
//
// SEGREDOS: senha do .pfx, base64 do .pfx e CSC token NUNCA são logados nem
// devolvidos. CSC token é cifrado (encryptString) e csc_token em claro é
// NULLado. O .pfx é validado + cifrado por certStore (AES-256-GCM).
//
// CACHE: a emissão (routes/nfce.js) tem _engineCapableCache de 60s — uma
// mudança de CSC/A1/provider aqui reflete na emissão em ATÉ 60s (não há
// invalidação cross-módulo; é aceitável e documentado).
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const certStore = require('../services/sefazSp/certStore');
const sefazSp = require('../services/sefazSp');
const engineBreaker = require('../services/sefazSp/engineBreaker');
const { encryptString, hasMasterKey } = require('../utils/secretCrypto');
const g = require('../services/auraNotas/gestao');

// ── Staff-gate: só contas internas da Aura (is_staff no JWT) ──────────────
function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  if (req.user.is_staff !== true) {
    return res.status(403).json({ error: 'Acesso restrito à equipe Aura' });
  }
  next();
}
router.use(requireAuth, requireStaff);

// ── helpers de leitura defensivos (schema pré-migration: 42703/42P01) ──────

// Certificados por empresa (mapa). Tabela company_certificates = migration 234;
// ausente → mapa vazio (empresa aparece sem cert).
async function certMap(companyId) {
  try {
    const params = [];
    let where = '';
    if (companyId) { params.push(companyId); where = 'WHERE company_id=$1'; }
    const { rows } = await db.query(
      `SELECT company_id, subject_cn, not_before, not_after, updated_at
         FROM company_certificates ${where}`, params);
    const m = new Map();
    for (const r of rows) m.set(r.company_id, r);
    return m;
  } catch (e) {
    if (e.code === '42P01') return new Map();
    throw e;
  }
}

// Agregados 30d por empresa (provider_used/fallback_reason = migration 237;
// ausente → só total, demais 0).
async function statsMap(companyId) {
  const params = [];
  let extra = '';
  if (companyId) { params.push(companyId); extra = ` AND company_id=$1`; }
  const base = `FROM nfce_emissions WHERE created_at >= NOW()-INTERVAL '30 days'${extra}`;
  try {
    const { rows } = await db.query(
      `SELECT company_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE provider_used='sefaz_sp')::int AS engine,
              COUNT(*) FILTER (WHERE provider_used IS DISTINCT FROM 'sefaz_sp')::int AS gateway,
              COUNT(*) FILTER (WHERE fallback_reason IS NOT NULL)::int AS fallbacks
         ${base} GROUP BY company_id`, params);
    return toStatsMap(rows);
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await db.query(
      `SELECT company_id, COUNT(*)::int AS total FROM nfce_emissions
        WHERE created_at >= NOW()-INTERVAL '30 days'${extra} GROUP BY company_id`, params);
    return toStatsMap(rows.map(r => ({ ...r, engine: 0, gateway: r.total, fallbacks: 0 })));
  }
}
function toStatsMap(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.company_id, {
      total: r.total || 0, engine: r.engine || 0,
      gateway: r.gateway || 0, fallbacks: r.fallbacks || 0,
    });
  }
  return m;
}
function emptyStats() { return { total: 0, engine: 0, gateway: 0, fallbacks: 0 }; }

// Última emissão por empresa (mapa). provider_used defensivo (237).
async function lastEmissionMap(companyId) {
  const params = [];
  let where = '';
  if (companyId) { params.push(companyId); where = 'WHERE company_id=$1'; }
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (company_id) company_id, created_at AS at, provider_used, status
         FROM nfce_emissions ${where} ORDER BY company_id, created_at DESC`, params);
    return toLastMap(rows);
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await db.query(
      `SELECT DISTINCT ON (company_id) company_id, created_at AS at, status
         FROM nfce_emissions ${where} ORDER BY company_id, created_at DESC`, params);
    return toLastMap(rows.map(r => ({ ...r, provider_used: null })));
  }
}
function toLastMap(rows) {
  const m = new Map();
  for (const r of rows) {
    m.set(r.company_id, { at: r.at, provider_used: r.provider_used || null, status: r.status || null });
  }
  return m;
}

function certValidNow(certRow) {
  return !!(certRow && certRow.not_after && new Date(certRow.not_after) > new Date());
}

// ── 1. GET /companies — visão geral (todas as empresas com nfce_config) ────
router.get('/companies', async (req, res) => {
  try {
    // nc.* pega provider/csc_token_enc/serie_sefaz_sp só se as colunas existem
    // (migrations 234/237); acesso a prop ausente vira undefined em JS.
    const { rows: cfgs } = await db.query(
      `SELECT nc.*, COALESCE(c.trade_name, c.legal_name) AS name, c.cnpj
         FROM nfce_config nc
         JOIN companies c ON c.id = nc.company_id
        ORDER BY COALESCE(c.trade_name, c.legal_name) NULLS LAST`);

    const [certs, stats, lasts] = await Promise.all([certMap(), statsMap(), lastEmissionMap()]);

    const companies = cfgs.map((cfg) => {
      const cid = cfg.company_id;
      const certRow = certs.get(cid) || null;
      const certValid = certValidNow(certRow);
      const cscOk = g.cscOk(cfg);
      const engineCap = g.engineCapable(cfg, certValid);
      const provider = (cfg.provider === undefined) ? null : cfg.provider;
      const last = lasts.get(cid) || null;
      return {
        company_id: cid,
        name: cfg.name || null,
        cnpj: cfg.cnpj || null,
        ambiente: cfg.ambiente || null,
        provider: provider,
        provider_efetivo: g.providerEfetivo(provider, engineCap),
        engine_capable: engineCap,
        csc_ok: cscOk,
        serie_sefaz_sp: (cfg.serie_sefaz_sp === undefined) ? null : cfg.serie_sefaz_sp,
        cert: certRow ? {
          subject_cn: certRow.subject_cn || null,
          not_after: certRow.not_after,
          days_left: g.daysLeft(certRow.not_after),
        } : null,
        last_emission: last ? {
          at: last.at, provider_used: last.provider_used, status: last.status,
        } : null,
        stats_30d: stats.get(cid) || emptyStats(),
        breaker_open: safeBreakerOpen(cid),
      };
    });

    res.json({ companies });
  } catch (err) {
    console.error('[aura-notas] GET /companies error:', err.message);
    res.status(500).json({ error: 'Erro ao listar empresas do Aura Notas' });
  }
});

function safeBreakerOpen(companyId) {
  try { return engineBreaker.isOpen(companyId); } catch (_) { return false; }
}

// ── 2. GET /:companyId — detalhe fiscal + config + cert + telemetria ───────
router.get('/:companyId', async (req, res) => {
  const cid = req.params.companyId;
  try {
    const { rows: comps } = await db.query(
      `SELECT legal_name, trade_name, cnpj,
              address_street, address_number, address_district,
              address_city, address_state, address_zip,
              ibge_code, inscricao_estadual, tax_regime
         FROM companies WHERE id=$1`, [cid]);
    if (!comps.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const company = comps[0];

    const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [cid]);
    const cfg = cfgs[0] || {};

    const certs = await certMap(cid);
    const certRow = certs.get(cid) || null;
    const certValid = certValidNow(certRow);
    const stats = await statsMap(cid);

    res.json({
      company: {
        legal_name: company.legal_name || null,
        trade_name: company.trade_name || null,
        cnpj: company.cnpj || null,
        address_street: company.address_street || null,
        address_number: company.address_number || null,
        address_district: company.address_district || null,
        address_city: company.address_city || null,
        address_state: company.address_state || null,
        address_zip: company.address_zip || null,
        ibge_code: company.ibge_code || null,
        inscricao_estadual: company.inscricao_estadual || null,
        tax_regime: company.tax_regime || null,
      },
      config: {
        ambiente: cfg.ambiente || null,
        uf: cfg.uf || null,
        provider: (cfg.provider === undefined) ? null : cfg.provider,
        serie_nfce: (cfg.serie_nfce === undefined) ? null : cfg.serie_nfce,
        next_number: (cfg.next_number === undefined) ? null : cfg.next_number,
        serie_sefaz_sp: (cfg.serie_sefaz_sp === undefined) ? null : cfg.serie_sefaz_sp,
        next_number_sefaz_sp: (cfg.next_number_sefaz_sp === undefined) ? null : cfg.next_number_sefaz_sp,
        csc_id: cfg.csc_id || null,
        csc_ok: g.cscOk(cfg),
        is_active: (cfg.is_active === undefined) ? null : cfg.is_active,
      },
      cert: certRow ? {
        subject_cn: certRow.subject_cn || null,
        not_before: certRow.not_before || null,
        not_after: certRow.not_after || null,
        days_left: g.daysLeft(certRow.not_after),
        updated_at: certRow.updated_at || null,
      } : null,
      stats_30d: stats.get(cid) || emptyStats(),
      breaker_open: safeBreakerOpen(cid),
    });
  } catch (err) {
    console.error('[aura-notas] GET /:companyId error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar empresa do Aura Notas' });
  }
});

// ── 3. PUT /:companyId/fiscal — dados fiscais da empresa + config ──────────
// Aceita qualquer subconjunto. Campos da company vão pra companies; ambiente/
// uf/provider/serie_sefaz_sp/is_active vão pra nfce_config.
router.put('/:companyId/fiscal', async (req, res) => {
  const cid = req.params.companyId;
  const b = req.body || {};

  // Validação campo-a-campo. companyCols: bodyKey === dbCol.
  const companyFields = [];
  const COMPANY_PLAIN = ['legal_name', 'trade_name', 'address_street', 'address_number',
    'address_district', 'address_city', 'address_state'];

  // texto simples
  for (const col of COMPANY_PLAIN) {
    if (b[col] !== undefined) companyFields.push({ col, val: b[col] === '' ? null : b[col] });
  }
  // cnpj: 11 ou 14 dígitos (ou limpa)
  if (b.cnpj !== undefined) {
    if (b.cnpj === null || b.cnpj === '') companyFields.push({ col: 'cnpj', val: null });
    else {
      const nums = String(b.cnpj).replace(/\D/g, '');
      if (nums.length !== 11 && nums.length !== 14) {
        return res.status(400).json({ error: 'CNPJ/CPF inválido (11 ou 14 dígitos)' });
      }
      companyFields.push({ col: 'cnpj', val: nums });
    }
  }
  // validados
  const validators = {
    inscricao_estadual: g.validateInscricaoEstadual,
    address_zip: g.validateCep,
    ibge_code: g.validateIbge,
    tax_regime: g.validateTaxRegime,
  };
  for (const col of Object.keys(validators)) {
    if (b[col] === undefined) continue;
    const r = validators[col](b[col]);
    if (!r.ok) return res.status(400).json({ error: r.error });
    companyFields.push({ col, val: r.value });
  }

  // nfce_config: ambiente, uf, provider, serie_sefaz_sp, is_active
  const configFields = [];
  const amb = g.validateAmbiente(b.ambiente);
  if (!amb.ok) return res.status(400).json({ error: amb.error });
  if (amb.value !== undefined) configFields.push({ col: 'ambiente', val: amb.value });

  const uf = g.validateUf(b.uf);
  if (!uf.ok) return res.status(400).json({ error: uf.error });
  if (uf.value !== undefined) configFields.push({ col: 'uf', val: uf.value });

  const prov = g.normalizeProvider(b.provider);
  if (!prov.ok) return res.status(400).json({ error: prov.error });
  if (prov.value !== undefined) configFields.push({ col: 'provider', val: prov.value });

  const serie = g.validateSerieSefazSp(b.serie_sefaz_sp);
  if (!serie.ok) return res.status(400).json({ error: serie.error });
  if (serie.value !== undefined) configFields.push({ col: 'serie_sefaz_sp', val: serie.value });

  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return res.status(400).json({ error: 'is_active deve ser boolean' });
    configFields.push({ col: 'is_active', val: b.is_active });
  }

  if (!companyFields.length && !configFields.length) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  try {
    if (companyFields.length) {
      const set = companyFields.map((f, i) => `${f.col}=$${i + 1}`);
      const vals = companyFields.map((f) => f.val);
      vals.push(cid);
      const { rowCount } = await db.query(
        `UPDATE companies SET ${set.join(', ')}, updated_at=NOW() WHERE id=$${vals.length}`, vals);
      if (!rowCount) return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    if (configFields.length) {
      const set = configFields.map((f, i) => `${f.col}=$${i + 1}`);
      const vals = configFields.map((f) => f.val);
      vals.push(cid);
      try {
        await db.query(
          `UPDATE nfce_config SET ${set.join(', ')}, updated_at=NOW() WHERE company_id=$${vals.length}`, vals);
      } catch (e) {
        if (e.code === '42703') {
          return res.status(400).json({ error: 'Colunas de configuração ausentes no banco (migration 237 pendente).' });
        }
        throw e;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[aura-notas] PUT /fiscal error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar dados fiscais' });
  }
});

// ── 4. PUT /:companyId/csc — CSC (idToken + código). Token cifrado. ────────
router.put('/:companyId/csc', async (req, res) => {
  const cid = req.params.companyId;
  const idR = g.validateCscId((req.body || {}).csc_id);
  if (!idR.ok) return res.status(400).json({ error: idR.error });
  const tokR = g.validateCscToken((req.body || {}).csc_token);
  if (!tokR.ok) return res.status(400).json({ error: tokR.error });

  if (!hasMasterKey()) {
    return res.status(503).json({ error: 'CERT_MASTER_KEY não configurada no servidor. Não é possível cifrar o CSC com segurança.' });
  }

  try {
    const tokenEnc = encryptString(tokR.value); // NUNCA persistir em claro
    let result;
    try {
      // csc_token=NULL: expurga qualquer legado em claro
      result = await db.query(
        `UPDATE nfce_config SET csc_id=$1, csc_token_enc=$2, csc_token=NULL, updated_at=NOW()
          WHERE company_id=$3`, [idR.value, tokenEnc, cid]);
    } catch (e) {
      if (e.code === '42703') {
        return res.status(400).json({ error: 'Coluna csc_token_enc ausente no banco (migration 234 pendente).' });
      }
      throw e;
    }
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Configuração NFC-e não encontrada para esta empresa. Salve os dados fiscais primeiro.' });
    }
    res.json({ ok: true });
  } catch (err) {
    // Não ecoar o token/erro de cifra com payload.
    console.error('[aura-notas] PUT /csc error:', err.code || err.message);
    res.status(500).json({ error: 'Erro ao salvar CSC' });
  }
});

// ── 5. POST /:companyId/certificate — upload do A1 (.pfx). ─────────────────
router.post('/:companyId/certificate', async (req, res) => {
  const cid = req.params.companyId;
  const { pfx_base64, password } = req.body || {};
  if (typeof pfx_base64 !== 'string' || !pfx_base64.trim()) {
    return res.status(400).json({ error: 'pfx_base64 obrigatório (arquivo .pfx em base64)' });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'password obrigatório (senha do certificado)' });
  }
  if (!hasMasterKey()) {
    return res.status(503).json({ error: 'CERT_MASTER_KEY não configurada no servidor. Não é possível guardar o certificado com segurança.' });
  }

  let pfxBuffer;
  try {
    pfxBuffer = Buffer.from(pfx_base64, 'base64');
  } catch (_) {
    return res.status(400).json({ error: 'pfx_base64 inválido (não é base64)' });
  }
  if (!pfxBuffer || pfxBuffer.length === 0) {
    return res.status(400).json({ error: 'pfx_base64 inválido (vazio)' });
  }

  try {
    // certStore valida o .pfx (openPfx: senha/validade) e cifra AES-256-GCM.
    const info = await certStore.saveCertificate(db, cid, pfxBuffer, password);
    res.status(201).json({
      subject_cn: info.subject_cn,
      not_before: info.not_before,
      not_after: info.not_after,
      days_left: g.daysLeft(info.not_after),
    });
  } catch (err) {
    // Erros do openPfx (senha incorreta / expirado / formato) são mensagens
    // amigáveis → 400. NUNCA logar senha/base64.
    const msg = err && err.message ? err.message : 'Falha ao processar o certificado';
    if (/openPfx|Certificado|senha|pfx|expirad/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    console.error('[aura-notas] POST /certificate error:', err.code || 'erro');
    res.status(500).json({ error: 'Erro ao salvar certificado' });
  }
});

// ── 6. POST /:companyId/test-conexao — status do serviço na SEFAZ ──────────
// Diagnóstico: erro de transporte NÃO é 5xx (é resultado do teste). HTTP 200.
router.post('/:companyId/test-conexao', async (req, res) => {
  const cid = req.params.companyId;
  const started = Date.now();
  try {
    const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [cid]);
    if (!cfgs.length) {
      return res.json({ ok: false, cStat: null, motivo: 'Configuração NFC-e não encontrada para esta empresa.', latency_ms: Date.now() - started });
    }
    const r = await sefazSp.statusServico({ config: cfgs[0], db, companyId: cid });
    res.json({
      ok: r.online === true || String(r.cStat) === '107',
      cStat: r.cStat || null,
      motivo: r.xMotivo || null,
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    // Cert ausente / SEFAZ fora / senha do A1 inválida → diagnóstico, não 5xx.
    res.json({ ok: false, cStat: null, motivo: err && err.message ? err.message : 'Falha na conexão', latency_ms: Date.now() - started });
  }
});

module.exports = router;
