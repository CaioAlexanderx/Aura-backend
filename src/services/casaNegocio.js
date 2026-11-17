// ============================================================
// AURA. — "Casa no Negocio" por empresa (p-189, 17/11/2026)
//
// A virada do Studio para a frente Personalizados do shell Negocio e unica,
// no fim, com tudo pronto (decisao D5 do Caio). Ela acontece empresa por
// empresa, pela equipe, nesta chave:
//
//   companies.studio_settings.casa_negocio = true
//
// Onde mora: studio_settings, e nao pdv_settings, porque
//   - o PUT /pdv-settings do lojista REGRAVA o pdv_settings inteiro
//     (routes/pdvSettings.js: pdv_settings = $1 || <data preservada>): uma
//     chave da equipe ali sumiria no primeiro "Salvar" das Configuracoes;
//   - o PATCH /studio/settings so faz merge (||) e so aceita a lista
//     ALLOWED_STUDIO_SETTINGS (routes/studio.js): o lojista nao grava nem
//     apaga casa_negocio;
//   - a coluna ja existe (migration 130): sem migration.
//
// Ligar (so empresa no /studio de hoje: vertical_active = 'studio' e
// pdv_settings.studio_enabled = true, plano Negocio ou acima):
//   1. grava a data original da frente (personalizadosAtivacao.
//      gravarDataOriginalDoStudio), ANTES de tirar a vertical: a funcao so
//      grava com a frente ligada, e nunca sobrescreve uma data;
//   2. vertical_active = NULL (e vertical_enabled_at = NULL, como
//      setCompanyVertical faz ao desativar). A data em que a vertical foi
//      ligada fica guardada em studio_settings.casa_negocio_studio_desde,
//      para a volta;
//   3. studio_settings.casa_negocio = true, casa_negocio_em = agora.
//   NUNCA toca pdv_settings.studio_enabled: a loja publica (vitrine Studio,
//   vitrineStudioShell.js) e a frente Personalizados dependem dele.
//
// Desligar (a volta): vertical_active = 'studio' de novo, com o
// vertical_enabled_at de antes; casa_negocio = false. A data de ativacao
// fica (ela nunca e apagada; religar a casa mantem a primeira).
//
// Cada troca grava admin_audit_log na MESMA transacao: sem log, sem troca.
// Nada aqui roda sozinho: so a rota da equipe (routes/adminCasaNegocio.js)
// chama, uma empresa por vez.
// ============================================================
'use strict';

const AppError = require('../errors/AppError');
const ativacao = require('./personalizadosAtivacao');

const CHAVE = 'casa_negocio';

function casaLigada(studioSettings) {
  return !!studioSettings && typeof studioSettings === 'object' && studioSettings[CHAVE] === true;
}

// Usada por services/segment.js (troca de frente pela equipe ou pelo
// cliente): empresa com a casa ligada nao volta para a vertical Studio.
async function casaLigadaNoBanco(conn, companyId) {
  const { rows } = await conn.query(
    `SELECT COALESCE(studio_settings->>'${CHAVE}', '') = 'true' AS ligada
       FROM companies WHERE id = $1`,
    [companyId]
  );
  return !!(rows[0] && rows[0].ligada === true);
}

const SELECT_EMPRESA = `SELECT id, plan, trade_name, vertical_active, vertical_enabled_at,
                               pdv_settings, studio_settings
                          FROM companies WHERE id = $1`;

async function lerEmpresa(conn, companyId, { travar = false } = {}) {
  const { rows } = await conn.query(SELECT_EMPRESA + (travar ? ' FOR UPDATE' : ''), [companyId]);
  return rows[0] || null;
}

function planoComStudio(plan) {
  // Mesma lista de services/segment.js (STUDIO_PLANS). Require tardio: o
  // segment.js tambem le este modulo.
  return require('./segment').canHaveStudio(plan);
}

// Por que nao da para ligar agora (null = pode).
function motivoParaNaoLigar(row) {
  if (!row) return 'empresa_nao_encontrada';
  if (casaLigada(row.studio_settings)) return 'ja_ligada';
  if (row.vertical_active !== 'studio') return 'nao_esta_no_studio';
  if (!row.pdv_settings || row.pdv_settings.studio_enabled !== true) return 'studio_desligado';
  if (!planoComStudio(row.plan)) return 'plano';
  return null;
}

// Por que nao da para desligar agora (null = pode). Outra vertical gravada
// depois da casa (food, odonto...) nao e trocada por baixo dos panos.
function motivoParaNaoDesligar(row) {
  if (!row) return 'empresa_nao_encontrada';
  if (!casaLigada(row.studio_settings)) return 'ja_desligada';
  if (row.vertical_active && row.vertical_active !== 'studio') return 'outra_vertical';
  return null;
}

const TEXTO_DO_MOTIVO = {
  empresa_nao_encontrada: 'Empresa não encontrada.',
  ja_ligada: 'A casa no Negócio já está ligada.',
  ja_desligada: 'A casa no Negócio já está desligada.',
  nao_esta_no_studio: 'Só empresa que está no Studio (vertical Studio) muda de casa.',
  studio_desligado: 'O Studio desta empresa está desligado (studio_enabled). Sem ele a frente Personalizados some no Negócio.',
  plano: 'Personalizados exige plano Negócio ou acima.',
  outra_vertical: 'A empresa está com outra vertical ativa. Troque a vertical antes de desligar a casa.',
};

function estadoDaCasa(row) {
  const ss = (row && row.studio_settings) || {};
  const ps = (row && row.pdv_settings) || {};
  const motivoLigar = motivoParaNaoLigar(row);
  const motivoDesligar = motivoParaNaoDesligar(row);
  return {
    company_id: row ? row.id : null,
    casa_negocio: casaLigada(ss),
    casa_negocio_em: ss.casa_negocio_em || null,
    vertical_active: row ? (row.vertical_active || null) : null,
    studio_enabled: ps.studio_enabled === true,
    personalizados_ativado_em: ps[ativacao.CHAVE] || null,
    pode_ligar: motivoLigar === null,
    motivo_ligar: motivoLigar,
    pode_desligar: motivoDesligar === null,
    motivo_desligar: motivoDesligar,
  };
}

function erroDoMotivo(motivo) {
  const err = new AppError(TEXTO_DO_MOTIVO[motivo] || 'Não deu para trocar a casa.', motivo === 'empresa_nao_encontrada' ? 404 : 409);
  err.code = 'CASA_' + String(motivo).toUpperCase();
  return err;
}

async function registrar(conn, { staffUserId, companyId, action, payload }) {
  await conn.query(
    `INSERT INTO admin_audit_log (staff_user_id, action, company_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [staffUserId || null, action, companyId, JSON.stringify(payload)]
  );
}

// `conn` precisa estar numa transacao aberta pelo chamador.
async function ligarCasa(conn, companyId, { staffUserId = null, agora = new Date() } = {}) {
  const antes = await lerEmpresa(conn, companyId, { travar: true });
  if (antes && casaLigada(antes.studio_settings)) {
    return { changed: false, data_original: null, estado: estadoDaCasa(antes) };
  }
  const motivo = motivoParaNaoLigar(antes);
  if (motivo) throw erroDoMotivo(motivo);

  // 1. data original, com a vertical Studio ainda gravada (frente ligada).
  const dataOriginal = await ativacao.gravarDataOriginalDoStudio(conn, companyId);

  // 2 e 3. tira a vertical e liga a casa. Nao menciona pdv_settings.
  const studioDesde = antes.vertical_enabled_at ? new Date(antes.vertical_enabled_at).toISOString() : null;
  const { rows } = await conn.query(
    `UPDATE companies
        SET vertical_active = NULL,
            vertical_enabled_at = NULL,
            studio_settings = COALESCE(studio_settings, '{}'::jsonb)
                              || jsonb_build_object('${CHAVE}', true,
                                                    'casa_negocio_em', $2::text,
                                                    'casa_negocio_studio_desde', $3::text),
            updated_at = NOW()
      WHERE id = $1 AND vertical_active = 'studio'
      RETURNING id`,
    [companyId, agora.toISOString(), studioDesde]
  );
  if (!rows.length) throw erroDoMotivo('nao_esta_no_studio');

  const depois = await lerEmpresa(conn, companyId);
  await registrar(conn, {
    staffUserId,
    companyId,
    action: 'casa_negocio_on',
    payload: {
      from: { vertical_active: 'studio', casa_negocio: false },
      to: { vertical_active: null, casa_negocio: true },
      studio_enabled: depois && depois.pdv_settings ? depois.pdv_settings.studio_enabled === true : null,
      studio_desde: studioDesde,
      data_original: dataOriginal,
    },
  });
  return { changed: true, data_original: dataOriginal, estado: estadoDaCasa(depois) };
}

// `conn` precisa estar numa transacao aberta pelo chamador.
async function desligarCasa(conn, companyId, { staffUserId = null, agora = new Date() } = {}) {
  const antes = await lerEmpresa(conn, companyId, { travar: true });
  if (antes && !casaLigada(antes.studio_settings)) {
    return { changed: false, estado: estadoDaCasa(antes) };
  }
  const motivo = motivoParaNaoDesligar(antes);
  if (motivo) throw erroDoMotivo(motivo);

  await conn.query(
    `UPDATE companies
        SET vertical_active = 'studio',
            vertical_enabled_at = COALESCE(
              NULLIF(studio_settings->>'casa_negocio_studio_desde', '')::timestamptz,
              vertical_enabled_at,
              NOW()),
            studio_settings = COALESCE(studio_settings, '{}'::jsonb)
                              || jsonb_build_object('${CHAVE}', false,
                                                    'casa_negocio_desligada_em', $2::text),
            updated_at = NOW()
      WHERE id = $1`,
    [companyId, agora.toISOString()]
  );

  const depois = await lerEmpresa(conn, companyId);
  await registrar(conn, {
    staffUserId,
    companyId,
    action: 'casa_negocio_off',
    payload: {
      from: { vertical_active: antes.vertical_active || null, casa_negocio: true },
      to: { vertical_active: 'studio', casa_negocio: false },
      studio_enabled: depois && depois.pdv_settings ? depois.pdv_settings.studio_enabled === true : null,
    },
  });
  return { changed: true, estado: estadoDaCasa(depois) };
}

async function estadoDaEmpresa(conn, companyId) {
  const row = await lerEmpresa(conn, companyId);
  if (!row) throw erroDoMotivo('empresa_nao_encontrada');
  return estadoDaCasa(row);
}

module.exports = {
  CHAVE,
  TEXTO_DO_MOTIVO,
  casaLigada,
  casaLigadaNoBanco,
  motivoParaNaoLigar,
  motivoParaNaoDesligar,
  estadoDaCasa,
  estadoDaEmpresa,
  ligarCasa,
  desligarCasa,
};
