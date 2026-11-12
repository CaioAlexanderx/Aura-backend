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
//
// 06/08/2026 — "Adicionar empresa" / "Remover" (Gestão Aura > Aura Notas):
// GET /companies é um INNER JOIN com nfce_config, então uma empresa que já
// existe no sistema (cadastrada pelo cliente) mas ainda não tem config fiscal
// nenhuma (ex.: Finesse/AP) fica INVISÍVEL nesse painel. GET /empresas-sem-config
// é a busca que alimenta o botão "Adicionar empresa" (escolher uma empresa já
// existente pra configurar). PUT /:companyId/fiscal virou um UPSERT — o MESMO
// formulário/endpoint que edita também cria a linha de nfce_config quando ela
// não existe ainda. DELETE /:companyId/fiscal é o "Remover": tira só a config
// fiscal (nfce_config + certificado A1), não mexe na empresa em si.
//
// 12/11/2026 — certificados e requisitos (decisão do Caio):
//   - GET /companies inclui toda empresa com certificado A1 (de qualquer
//     fonte), além das que têm nfce_config; diz o que cada uma tem (NFC-e,
//     NFS-e, validade do certificado) — só acréscimos no contrato;
//   - GET /:companyId traz a lista de requisitos de NFC-e e NFS-e
//     (services/auraNotas/requisitos.js) e a NFS-e sem segredo;
//   - PUT /:companyId/nfse: a equipe edita a NFS-e com as regras do lojista;
//   - produção e série/número pedem confirmação explícita (409 CONFIRMAR_*);
//   - DELETE não apaga o A1 de quem usa NFS-e sem ?certificado=apagar;
//   - toda alteração da equipe vai para admin_audit_log (staff_user_id).
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
// 12/11/2026: lista do que está ok e do que falta para emitir NFC-e e NFS-e.
const req_ = require('../services/auraNotas/requisitos');
// 19/10/2026 (decisão do Caio): dojô não aparece nem conta na Gestão Aura.
const { semDojo } = require('../utils/empresasDaGestao');
// tq-113 (26/10/2026): conta pendente (dono nunca confirmou o e-mail) sai junto.
const { semPendente } = require('../utils/contaPendente');
const { ENDPOINTS: SEFAZ_SP_ENDPOINTS_65 } = require('../services/sefazSp/endpoints');
// 12/11/2026: NFS-e pela equipe com as MESMAS regras do lojista.
const { salvarConfigNfse } = require('./nfse');
const { normalizarSerie } = require('../services/nfseNacional/dpsBuilder');
const { normalizarAmbiente } = require('../services/nfseNacional/endpoints');

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

// ── 12/11/2026: certificado de qualquer fonte + NFS-e na lista ─────────────
// Decisão do Caio (12/11/2026): toda empresa que cadastrou certificado A1
// aparece no Aura Notas, mesmo sem nfce_config (ex.: quem usa só NFS-e).
// Onde um A1 pode estar guardado (conferido no código):
//   - company_certificates ............ cofre atual (NFC-e própria e NFS-e
//                                       nacional usam o MESMO certificado);
//   - nfse_config.certificate_url ..... NFS-e antiga (provider por URL R2);
//   - companies.certificate_uploaded .. envio antigo à Nuvem Fiscal
//                                       (routes/nfe.js POST /certificate);
//   - nfce_config.certificate_file .... coluna antiga (DEPRECATED, migration
//                                       234) — só existe com nfce_config.
// Das fontes antigas só se sabe QUE houve envio (sem validade): a tela pede
// o certificado de novo no cofre. Nenhuma senha, pfx ou CSC sai daqui.

const FONTE_COFRE = 'cofre';
const FONTE_NFSE_LEGADO = 'nfse_legado';
const FONTE_NUVEM_FISCAL = 'nuvem_fiscal_legado';
const FONTE_NFCE_LEGADO = 'nfce_legado';

// Campos de nfse_config que podem sair para a tela (lista branca). Fica de
// fora tudo que é segredo: api_key_encrypted, api_secret, certificate_pwd,
// certificate_url (vira só a fonte 'nfse_legado').
const NFSE_CAMPOS_PUBLICOS = [
  'provider', 'ambiente', 'is_active', 'serie', 'next_dps_number',
  'municipio_ibge', 'ctribnac_padrao', 'cnbs_padrao', 'op_simp_nac', 'reg_ap_trib_sn',
  'reg_esp_trib', 'p_tot_trib_sn', 'default_iss_rate', 'inscricao_municipal',
  'prefeitura_cadastro_confirmado', 'cliente_retem_iss', 'aliquota_iss_retencao_sn',
  'outro_emissor', 'outro_emissor_serie', 'outro_emissor_ultimo_numero',
  'dps_conflito_em', 'dps_conflito_serie', 'dps_conflito_numero',
  'ultimo_teste_em', 'ultimo_teste_status', 'ultimo_teste_codigo', 'ultimo_teste_mensagem',
  'serie_confirmada_em', 'emissao_automatica',
];

function nfseSemSegredo(row) {
  if (!row) return null;
  const out = {};
  for (const k of NFSE_CAMPOS_PUBLICOS) out[k] = row[k] === undefined ? null : row[k];
  // bigint: o pg devolve string; a tela trata como texto
  for (const k of ['next_dps_number', 'outro_emissor_ultimo_numero', 'dps_conflito_numero']) {
    if (out[k] != null) out[k] = String(out[k]);
  }
  return out;
}

// nfse_config por empresa (mapa). A linha inteira fica em memória (o passo da
// nota de teste precisa dos error_codes da última nota de teste, como no repo
// da NFS-e), mas só nfseSemSegredo() sai na resposta. Tabela ausente → vazio.
async function nfseMap(companyId) {
  const params = [];
  let where = '';
  if (companyId) { params.push(companyId); where = 'WHERE nf.company_id=$1'; }
  try {
    const { rows } = await db.query(
      `SELECT nf.*, t.error_codes AS ultimo_teste_error_codes
         FROM nfse_config nf
         LEFT JOIN nfse t ON t.id = nf.ultimo_teste_nfse_id AND t.company_id = nf.company_id
                         AND nf.ultimo_teste_status = 'rejeitado'
         ${where}`, params);
    return toNfseMap(rows);
  } catch (e) {
    if (e.code === '42P01') return new Map();
    if (e.code !== '42703') throw e;
    const { rows } = await db.query(`SELECT nf.* FROM nfse_config nf ${where}`, params);
    return toNfseMap(rows);
  }
}
function toNfseMap(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.company_id, r);
  return m;
}

// Envio antigo do A1 à Nuvem Fiscal (companies.certificate_uploaded). Coluna
// ausente → conjunto vazio.
async function nuvemFiscalLegadoSet(companyId) {
  try {
    const params = [];
    let extra = '';
    if (companyId) { params.push(companyId); extra = ' AND id=$1'; }
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE certificate_uploaded IS TRUE${extra}`, params);
    return new Set(rows.map((r) => r.id));
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return new Set();
    throw e;
  }
}

function fontesDoCertificado({ certRow, nfseRow, nfceRow, nuvemLegado }) {
  const f = [];
  if (certRow) f.push(FONTE_COFRE);
  if (nfseRow && nfseRow.certificate_url) f.push(FONTE_NFSE_LEGADO);
  if (nuvemLegado) f.push(FONTE_NUVEM_FISCAL);
  if (nfceRow && nfceRow.certificate_file) f.push(FONTE_NFCE_LEGADO);
  return f;
}

// Certificado do cofre sem segredo. Mesmos campos de antes + vencido e
// vence_em_breve (até 30 dias).
function certPublico(certRow, extra) {
  if (!certRow) return null;
  const sit = req_.situacaoCertificado(certRow);
  return {
    subject_cn: certRow.subject_cn || null,
    ...(extra || {}),
    not_after: certRow.not_after,
    days_left: sit.days_left,
    vencido: sit.vencido,
    vence_em_breve: sit.vence_em_breve,
  };
}

function resumoNfse(nfseRow) {
  if (!nfseRow) return null;
  return {
    provider: nfseRow.provider || null,
    ambiente: nfseRow.ambiente || null,
    ativa: nfseRow.is_active === true,
    municipio_ibge: nfseRow.municipio_ibge || null,
  };
}

const contarFaltas = (r) => r.itens.filter((i) => i.estado === 'falta' || i.estado === 'problema').length;

// ── 1. GET /companies — visão geral ─────────────────────────────────────────
// Empresas com nfce_config (como sempre) + empresas com certificado A1 de
// qualquer fonte (12/11/2026). Uma linha por empresa. Dojô e conta pendente
// seguem fora (semDojo/semPendente nas duas consultas).
router.get('/companies', async (req, res) => {
  try {
    // nc.* pega provider/csc_token_enc/serie_sefaz_sp só se as colunas existem
    // (migrations 234/237); acesso a prop ausente vira undefined em JS. Os
    // campos da empresa vêm com prefixo co_ (nfce_config também tem
    // inscricao_estadual; sem prefixo um sobrescreveria o outro).
    const { rows: cfgs } = await db.query(
      `SELECT nc.*, COALESCE(c.trade_name, c.legal_name) AS name, c.cnpj,
              c.inscricao_estadual AS co_inscricao_estadual, c.tax_regime AS co_tax_regime,
              c.ibge_code AS co_ibge_code, c.address_state AS co_address_state,
              c.address_city AS co_address_city
         FROM nfce_config nc
         JOIN companies c ON c.id = nc.company_id
        WHERE ${semDojo('c')} AND ${semPendente('c')}
        ORDER BY COALESCE(c.trade_name, c.legal_name) NULLS LAST`);

    const [certs, stats, lasts, nfses, nuvemLegado] = await Promise.all([
      certMap(), statsMap(), lastEmissionMap(), nfseMap(), nuvemFiscalLegadoSet(),
    ]);

    // Empresas com certificado (qualquer fonte) que ainda não têm nfce_config.
    const comCfg = new Set(cfgs.map((c) => c.company_id));
    const candidatos = new Set([...certs.keys(), ...nuvemLegado]);
    for (const [cid, n] of nfses) if (n.certificate_url) candidatos.add(cid);
    const extrasIds = [...candidatos].filter((cid) => !comCfg.has(cid));
    let extras = [];
    if (extrasIds.length) {
      const { rows } = await db.query(
        `SELECT c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS name, c.cnpj,
                c.inscricao_estadual AS co_inscricao_estadual, c.tax_regime AS co_tax_regime,
                c.ibge_code AS co_ibge_code, c.address_state AS co_address_state,
                c.address_city AS co_address_city
           FROM companies c
          WHERE c.id = ANY($1::uuid[]) AND ${semDojo('c')} AND ${semPendente('c')}
          ORDER BY COALESCE(c.trade_name, c.legal_name) NULLS LAST`, [extrasIds]);
      extras = rows;
    }

    const linha = (row, cfg) => {
      const cid = row.company_id;
      const certRow = certs.get(cid) || null;
      const nfseRow = nfses.get(cid) || null;
      const certValid = certValidNow(certRow);
      const c = cfg || {};
      const cscOk = g.cscOk(c);
      const engineCap = g.engineCapable(c, certValid);
      const provider = (c.provider === undefined) ? null : c.provider;
      const last = lasts.get(cid) || null;
      const company = empresaDaLinha(row);
      const rNfce = req_.requisitosNfce({ company, nfce: cfg, certRow });
      const rNfse = req_.requisitosNfse({ company, nfse: nfseRow, certRow });
      return {
        company_id: cid,
        name: row.name || null,
        cnpj: row.cnpj || null,
        ambiente: c.ambiente || null,
        provider: provider,
        provider_efetivo: g.providerEfetivo(provider, engineCap),
        engine_capable: engineCap,
        csc_ok: cscOk,
        serie_sefaz_sp: (c.serie_sefaz_sp === undefined) ? null : c.serie_sefaz_sp,
        cert: certPublico(certRow),
        last_emission: last ? {
          at: last.at, provider_used: last.provider_used, status: last.status,
        } : null,
        stats_30d: stats.get(cid) || emptyStats(),
        breaker_open: safeBreakerOpen(cid),
        // ── 12/11/2026 (só acréscimos) ──
        na_lista_por: cfg ? 'nfce_config' : 'certificado',
        nfce_configurada: !!cfg,
        nfse_configurada: !!nfseRow,
        nfse: resumoNfse(nfseRow),
        certificado_fontes: fontesDoCertificado({ certRow, nfseRow, nfceRow: cfg, nuvemLegado: nuvemLegado.has(cid) }),
        uf: c.uf || row.co_address_state || null,
        municipio: row.co_address_city || null,
        nfce_pronta: rNfce.pronta,
        nfse_apta: rNfse.apta,
        faltas: { nfce: contarFaltas(rNfce), nfse: contarFaltas(rNfse) },
      };
    };

    const companies = [
      ...cfgs.map((cfg) => linha(cfg, cfg)),
      ...extras.map((row) => linha(row, null)),
    ].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));

    res.json({ companies, ufs_atendidas: req_.ufsAtendidas() });
  } catch (err) {
    console.error('[aura-notas] GET /companies error:', err.message);
    res.status(500).json({ error: 'Erro ao listar empresas do Aura Notas' });
  }
});

function empresaDaLinha(row) {
  return {
    cnpj: row.cnpj, inscricao_estadual: row.co_inscricao_estadual, tax_regime: row.co_tax_regime,
    ibge_code: row.co_ibge_code, address_state: row.co_address_state,
  };
}

// Auditoria da equipe (admin_audit_log, migration 108). Best-effort: falha
// de auditoria nunca derruba a rota. NUNCA grave segredo no payload.
async function auditar(req, companyId, action, payload) {
  try {
    await db.query(
      `INSERT INTO admin_audit_log (staff_user_id, company_id, action, payload)
       VALUES ($1, $2, $3, $4)`,
      [req.user && req.user.id, companyId, action, JSON.stringify(payload || {})]);
  } catch (err) {
    console.warn('[aura-notas] admin_audit_log falhou:', err.code || err.message);
  }
}

// Ambiente e numeração atuais da NFC-e (para pedir confirmação só quando
// mudam). Sem as colunas da migration 237, só o ambiente.
async function configNfceAtual(cid) {
  try {
    const { rows } = await db.query(
      'SELECT ambiente, serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config WHERE company_id=$1', [cid]);
    return rows[0] || null;
  } catch (e) {
    if (e.code !== '42703') throw e;
    const { rows } = await db.query('SELECT ambiente FROM nfce_config WHERE company_id=$1', [cid]);
    return rows[0] || null;
  }
}

function safeBreakerOpen(companyId) {
  try { return engineBreaker.isOpen(companyId); } catch (_) { return false; }
}

// ── 1b. GET /empresas-sem-config — busca p/ o botão "Adicionar empresa" ────
// Empresas que JÁ existem em `companies` (cadastradas pelo próprio cliente,
// via signup ou multi-CNPJ) mas ainda NÃO têm linha em nfce_config — hoje
// ficam invisíveis em GET /companies (INNER JOIN). ?q= filtra por nome/CNPJ.
// Só empresas ativas (is_active=true na tabela companies).
router.get('/empresas-sem-config', async (req, res) => {
  const q = String((req.query || {}).q || '').trim();
  try {
    const params = [];
    let where = `WHERE c.is_active = true AND nc.company_id IS NULL AND ${semDojo('c')} AND ${semPendente('c')}`;
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (c.legal_name ILIKE $${params.length} OR c.trade_name ILIKE $${params.length} OR c.cnpj ILIKE $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS name,
              c.legal_name, c.trade_name, c.cnpj, c.address_state
         FROM companies c
         LEFT JOIN nfce_config nc ON nc.company_id = c.id
         ${where}
        ORDER BY COALESCE(c.trade_name, c.legal_name) NULLS LAST
        LIMIT 50`, params);
    res.json({ companies: rows });
  } catch (err) {
    console.error('[aura-notas] GET /empresas-sem-config error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar empresas sem configuração fiscal' });
  }
});

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
    const stats = await statsMap(cid);
    // 12/11/2026: NFS-e, fontes do certificado e requisitos de emissão.
    const nfses = await nfseMap(cid);
    const nfseRow = nfses.get(cid) || null;
    const nuvemLegado = await nuvemFiscalLegadoSet(cid);
    const nfceRow = cfgs[0] || null;
    const reqCompany = {
      cnpj: company.cnpj, inscricao_estadual: company.inscricao_estadual, tax_regime: company.tax_regime,
      ibge_code: company.ibge_code, address_state: company.address_state,
    };

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
        ...certPublico(certRow, { not_before: certRow.not_before || null }),
        not_after: certRow.not_after || null,
        updated_at: certRow.updated_at || null,
      } : null,
      stats_30d: stats.get(cid) || emptyStats(),
      breaker_open: safeBreakerOpen(cid),
      // ── 12/11/2026 (só acréscimos) ──
      nfce_configurada: !!nfceRow,
      nfse_configurada: !!nfseRow,
      nfse: nfseSemSegredo(nfseRow),
      certificado_fontes: fontesDoCertificado({ certRow, nfseRow, nfceRow, nuvemLegado: nuvemLegado.has(cid) }),
      ufs_atendidas: req_.ufsAtendidas(),
      requisitos: {
        nfce: req_.requisitosNfce({ company: reqCompany, nfce: nfceRow, certRow }),
        nfse: req_.requisitosNfse({ company: reqCompany, nfse: nfseRow, certRow }),
      },
    });
  } catch (err) {
    console.error('[aura-notas] GET /:companyId error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar empresa do Aura Notas' });
  }
});

// ── 3. PUT /:companyId/fiscal — dados fiscais da empresa + config ──────────
// Aceita qualquer subconjunto. Campos da company vão pra companies; ambiente/
// uf/provider/serie_sefaz_sp/is_active vão pra nfce_config.
//
// 06/08/2026: virou UPSERT em nfce_config (antes era UPDATE puro e, se a
// empresa ainda não tinha linha em nfce_config, o UPDATE afetava 0 linhas
// silenciosamente — a resposta dizia "ok:true" mas nada era salvo). Agora,
// se a linha não existe, é criada — é o que faz o botão "Adicionar empresa"
// funcionar reusando este MESMO endpoint/formulário.
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

  // null = "não mexer" (a tela manda null quando a empresa ainda não tem série)
  const serie = g.validateSerieSefazSp(b.serie_sefaz_sp === null ? undefined : b.serie_sefaz_sp);
  if (!serie.ok) return res.status(400).json({ error: serie.error });
  if (serie.value !== undefined) configFields.push({ col: 'serie_sefaz_sp', val: serie.value });

  // 12/11/2026: próximo número da emissão própria (antes só dava para ver).
  let proxNumero;
  if (b.next_number_sefaz_sp !== undefined && b.next_number_sefaz_sp !== null && b.next_number_sefaz_sp !== '') {
    const n = Number(String(b.next_number_sefaz_sp).replace(/\D/g, '') || NaN);
    if (!Number.isInteger(n) || n < 1 || n > 999999999) {
      return res.status(400).json({ error: 'next_number_sefaz_sp inválido (inteiro de 1 a 999999999)' });
    }
    proxNumero = n;
    configFields.push({ col: 'next_number_sefaz_sp', val: n });
  }

  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return res.status(400).json({ error: 'is_active deve ser boolean' });
    configFields.push({ col: 'is_active', val: b.is_active });
  }

  if (!companyFields.length && !configFields.length) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  // 06/08/2026 — Nuvem Fiscal não existe mais: se o provider vai ficar
  // 'sefaz_sp' (engine própria), a UF final precisa ter endpoints cadastrados
  // (ver services/sefazSp/endpoints.js — hoje SP, AP via SVRS e MG), senão a
  // emissão real ia estourar depois. Bloqueia aqui, na config.
  if (prov.value === 'sefaz_sp') {
    let effectiveUf = uf.value;
    if (effectiveUf === undefined) {
      const { rows: cur } = await db.query('SELECT uf FROM nfce_config WHERE company_id=$1', [cid]);
      effectiveUf = (cur[0] && cur[0].uf) || 'SP';
    }
    const ufKey = String(effectiveUf).toUpperCase();
    if (!SEFAZ_SP_ENDPOINTS_65[ufKey]) {
      return res.status(400).json({
        error: `UF ${ufKey} ainda não é suportada na emissão própria (engine SEFAZ). `
          + `UFs disponíveis: ${Object.keys(SEFAZ_SP_ENDPOINTS_65).join(', ')}.`,
      });
    }
  }

  // 12/11/2026: ir para produção e mexer na série/número pedem confirmação
  // explícita (a tela pergunta antes). Número repetido = nota rejeitada por
  // duplicidade na SEFAZ. Mandar o MESMO valor de antes não pede nada.
  let atual = null;
  let vaiParaProducao = false;
  let mudaNumeracao = false;
  try {
    atual = await configNfceAtual(cid);
  } catch (err) {
    console.error('[aura-notas] PUT /fiscal leitura:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar dados fiscais' });
  }
  vaiParaProducao = amb.value === 'producao' && !(atual && atual.ambiente === 'producao');
  mudaNumeracao = (serie.value !== undefined && !(atual && Number(atual.serie_sefaz_sp) === serie.value))
    || (proxNumero !== undefined && !(atual && Number(atual.next_number_sefaz_sp) === proxNumero));
  if (vaiParaProducao && b.confirmar_producao !== true) {
    return res.status(409).json({
      code: 'CONFIRMAR_PRODUCAO',
      error: 'Em produção as NFC-e passam a valer de verdade. Confirme a mudança para seguir.',
    });
  }
  if (mudaNumeracao && b.confirmar_numeracao !== true) {
    return res.status(409).json({
      code: 'CONFIRMAR_NUMERACAO',
      error: 'Mudar a série ou o próximo número pode repetir um número já usado, e a SEFAZ recusa nota com número repetido. Confirme a mudança para seguir.',
    });
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
      // UPSERT: cria a linha de nfce_config se a empresa ainda não tem uma
      // (botão "Adicionar empresa"), ou atualiza os campos enviados se já tem.
      const cols = ['company_id', ...configFields.map((f) => f.col)];
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      const vals = [cid, ...configFields.map((f) => f.val)];
      const updateSet = configFields.map((f) => `${f.col}=EXCLUDED.${f.col}`).join(', ');
      try {
        await db.query(
          `INSERT INTO nfce_config (${cols.join(', ')}, updated_at)
           VALUES (${placeholders.join(', ')}, NOW())
           ON CONFLICT (company_id) DO UPDATE SET ${updateSet}, updated_at=NOW()`,
          vals
        );
      } catch (e) {
        if (e.code === '42703') {
          return res.status(400).json({ error: 'Colunas de configuração ausentes no banco (migration 237 pendente).' });
        }
        throw e;
      }
    }
    await auditar(req, cid, 'aura_notas_fiscal', {
      empresa: Object.fromEntries(companyFields.map((f) => [f.col, f.val])),
      nfce: Object.fromEntries(configFields.map((f) => [f.col, f.val])),
      antes: atual ? { ambiente: atual.ambiente || null, serie_sefaz_sp: atual.serie_sefaz_sp ?? null, next_number_sefaz_sp: atual.next_number_sefaz_sp ?? null } : null,
      confirmou_producao: vaiParaProducao, confirmou_numeracao: mudaNumeracao,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[aura-notas] PUT /fiscal error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar dados fiscais' });
  }
});

// ── 3b. DELETE /:companyId/fiscal — botão "Remover" ─────────────────────────
// Remove SÓ a configuração fiscal do Aura Notas (nfce_config + certificado A1
// associado) — a empresa em si (login, vendas, etc.) continua existindo e
// ativa normalmente. NÃO é o mesmo "Remover empresa" do fluxo self-service
// de Multi-CNPJ (esse desativa a empresa inteira; não é o que este botão faz).
//
// Bloqueado se a empresa já EMITIU alguma nota fiscal por essa config (não dá
// pra apagar a config e deixar numero/série/protocolo órfãos de histórico
// real). Nesse caso o caminho é desativar (PUT /fiscal { is_active:false }),
// não remover — a mensagem de erro já indica isso.
//
// 12/11/2026: o certificado A1 do cofre é o MESMO da NFS-e nacional. Se a
// empresa tem nfse_config, apagar o A1 para a NFS-e dela. Por isso, nesse
// caso, o Remover só segue com ?certificado=apagar (a tela avisa que o
// certificado sai e que a NFS-e para). Sem isso → 409 CERTIFICADO_DA_NFSE e
// nada é apagado. Decisão do Caio: em NFC-e/NFS-e a saída é habilitar,
// nunca retirar — nada sai sem a equipe confirmar.
router.delete('/:companyId/fiscal', async (req, res) => {
  const cid = req.params.companyId;
  const apagarCertificado = String((req.query || {}).certificado || '') === 'apagar';
  // Fora da transação: tabela ausente (42P01) não pode abortar a transação.
  let temCertificado = false;
  let usaNfse = false;
  try {
    temCertificado = (await certMap(cid)).has(cid);
    usaNfse = (await nfseMap(cid)).has(cid);
  } catch (err) {
    console.error('[aura-notas] DELETE /:companyId/fiscal leitura:', err.message);
    return res.status(500).json({ error: 'Erro ao remover configuração fiscal' });
  }
  if (temCertificado && usaNfse && !apagarCertificado) {
    return res.status(409).json({
      code: 'CERTIFICADO_DA_NFSE',
      error: 'Esta empresa também emite NFS-e com o mesmo certificado A1. Remover apaga o certificado e a NFS-e para de emitir. Confirme para seguir.',
    });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: cfgs } = await client.query('SELECT company_id FROM nfce_config WHERE company_id=$1', [cid]);
    if (!cfgs.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Esta empresa não tem configuração fiscal no Aura Notas.' });
    }

    const { rows: emCount } = await client.query(
      'SELECT COUNT(*)::int AS n FROM nfce_emissions WHERE company_id=$1', [cid]);
    if (emCount[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Esta empresa já emitiu nota fiscal pelo Aura Notas — não é possível remover a configuração (o histórico fiscal ficaria órfão). Desative-a em vez de remover (is_active = false).',
        code: 'HAS_EMISSIONS',
      });
    }

    try {
      await client.query('DELETE FROM company_certificates WHERE company_id=$1', [cid]);
    } catch (e) {
      if (e.code !== '42P01') throw e; // tabela ausente (migration 234): ignora
    }
    await client.query('DELETE FROM nfce_config WHERE company_id=$1', [cid]);

    await client.query('COMMIT');
    await auditar(req, cid, 'aura_notas_remover', {
      certificado_removido: temCertificado, nfse_afetada: temCertificado && usaNfse,
    });
    res.json({ ok: true, certificado_removido: temCertificado, nfse_afetada: temCertificado && usaNfse });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[aura-notas] DELETE /:companyId/fiscal error:', err.message);
    res.status(500).json({ error: 'Erro ao remover configuração fiscal' });
  } finally {
    client.release();
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
    // só o id e o fato de o código ter sido trocado — o código nunca entra
    await auditar(req, cid, 'aura_notas_csc', { csc_id: idR.value, csc_token: 'trocado' });
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
    // só metadados públicos — nunca o pfx nem a senha
    await auditar(req, cid, 'aura_notas_certificado', { subject_cn: info.subject_cn, not_after: info.not_after });
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

// ── 5b. PUT /:companyId/nfse — NFS-e (emissor nacional) pela equipe ─────────
// 12/11/2026: a equipe edita a NFS-e na mesma tela, para agilizar o
// onboarding. As regras são as MESMAS do lojista: o corpo passa por
// salvarConfigNfse (routes/nfse.js, o miolo do PUT /nfse/config) — mesma
// validação (validarCamposNacional, validarRetencao, validarOutroEmissor),
// mesma trava para ligar (nota de teste aceita, produção liberada no
// servidor) e o número da DPS só anda para frente. Aqui só entram:
//   - lista branca de campos (nada de api_key, URL ou senha de certificado);
//   - provider 'nacional' (o único emissor de NFS-e que a Aura opera);
//   - confirmação explícita para ir à produção e para mexer na série ou no
//     próximo número (risco de número repetido);
//   - auditoria em admin_audit_log.
const NFSE_EDITAVEIS = [
  'ambiente', 'is_active', 'serie', 'next_dps_number', 'municipio_ibge', 'ctribnac_padrao',
  'cnbs_padrao', 'op_simp_nac', 'reg_ap_trib_sn', 'reg_esp_trib', 'p_tot_trib_sn',
  'default_iss_rate', 'inscricao_municipal', 'prefeitura_cadastro_confirmado',
  'cliente_retem_iss', 'aliquota_iss_retencao_sn', 'outro_emissor', 'outro_emissor_serie',
  'outro_emissor_ultimo_numero', 'serie_confirmada',
];

router.put('/:companyId/nfse', async (req, res) => {
  const cid = req.params.companyId;
  const b = req.body || {};
  const campos = {};
  for (const k of NFSE_EDITAVEIS) if (b[k] !== undefined) campos[k] = b[k];
  if (!Object.keys(campos).length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    const atual = (await nfseMap(cid)).get(cid) || null;
    const ambienteAntes = atual ? normalizarAmbiente(atual.ambiente) : null;
    // Mesma conta do lojista: ligar sem dizer o ambiente = produção.
    let ambienteDepois = campos.ambiente !== undefined ? normalizarAmbiente(campos.ambiente) : ambienteAntes;
    if (campos.ambiente === undefined && campos.is_active === true && !(atual && atual.is_active)) ambienteDepois = 'producao';
    const vaiParaProducao = ambienteDepois === 'producao' && ambienteAntes !== 'producao';
    const mudaSerie = campos.serie !== undefined
      && normalizarSerie(campos.serie) !== normalizarSerie((atual && atual.serie) || '1');
    const mudaNumero = campos.next_dps_number !== undefined
      && Number(campos.next_dps_number) !== Number((atual && atual.next_dps_number) || 1);
    if (vaiParaProducao && b.confirmar_producao !== true) {
      return res.status(409).json({
        code: 'CONFIRMAR_PRODUCAO',
        error: 'Em produção as NFS-e passam a valer de verdade. Confirme a mudança para seguir.',
      });
    }
    if ((mudaSerie || mudaNumero) && b.confirmar_numeracao !== true) {
      return res.status(409).json({
        code: 'CONFIRMAR_NUMERACAO',
        error: 'Mudar a série ou o próximo número da DPS pode repetir um número já usado, e o gov.br recusa nota com número repetido. Confirme a mudança para seguir.',
      });
    }

    const r = await salvarConfigNfse(cid, { ...campos, provider: 'nacional' });
    if (r.status < 300) {
      await auditar(req, cid, 'aura_notas_nfse', {
        campos,
        antes: atual ? {
          ambiente: atual.ambiente || null, serie: atual.serie || null,
          next_dps_number: atual.next_dps_number != null ? String(atual.next_dps_number) : null,
          is_active: atual.is_active === true, provider: atual.provider || null,
        } : null,
        confirmou_producao: vaiParaProducao, confirmou_numeracao: mudaSerie || mudaNumero,
      });
    }
    return res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[aura-notas] PUT /nfse error:', err.code || err.message);
    return res.status(500).json({ error: 'Erro ao salvar a NFS-e' });
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
