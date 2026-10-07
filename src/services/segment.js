// ============================================================
// AURA. — Frente da empresa (companies.segment)
//
// Decisao do fundador (05/10/2026): o cadastro pergunta o ramo, a Aura
// sugere pelo CNAE e o cliente confirma ou troca. A frente escolhida ja
// nasce ligada. Uma frente por empresa (por CNPJ) + o recurso extra
// "Ordem de Servico" para quem nao e assistencia.
//
// Este modulo e a UNICA fonte de:
//   (i)   a lista de frentes (SEGMENTS)
//   (ii)  a sugestao por CNAE (suggestSegmentFromCnae)
//   (iii) a aplicacao da frente no banco (applySegment)
//   (iv)  a ativacao/desativacao da vertical Studio (setCompanyVertical),
//         extraida de routes/adminVertical.js sem mudar o comportamento.
//
// Frente -> o que liga (pdv_settings e jsonb; merge com ||, nunca replace):
//   varejo       nada
//   matcon       pdv_settings.matcon_enabled = true
//   otica        pdv_settings.otica_enabled  = true
//   assistencia  pdv_settings.os_enabled     = true
//   studio       vertical_active = 'studio' + pdv_settings.studio_enabled = true
//                (so nos planos negocio/expansao/personalizado: no Essencial a empresa
//                ficaria presa em telas que o plano nao libera)
//   outro        nada
// Extras: so ['os'] -> os_enabled = true.
//
// NUNCA desliga nada, exceto:
//   - chamado por staff com `disable` explicito ou trocando a frente de
//     studio para outra (desativa a vertical Studio);
//   - `replacePrevious` (07/10/2026 — o cliente troca a propria frente em
//     Configuracoes, PATCH /companies/:id/segment): desliga a flag propria
//     da frente anterior (matcon_enabled / otica_enabled), desativa a
//     vertical ao sair do Studio e, se `extras` vier como lista VAZIA
//     explicita, desliga os_enabled (o extra). Sem `extras`, os_enabled fica
//     como esta.
//
// CNAEs conferidos na API oficial do IBGE (servicodados.ibge.gov.br/api/v2/
// cnae/subclasses/<codigo>) em 05/10/2026. So entra codigo conferido.
// ============================================================
'use strict';

const AppError = require('../errors/AppError');

const SEGMENTS = ['varejo', 'matcon', 'otica', 'assistencia', 'studio', 'outro'];
const SEGMENT_SOURCES = ['cnae', 'landing', 'user', 'staff'];
const ALLOWED_EXTRAS = ['os'];
const DISABLEABLE = ['matcon', 'otica', 'os'];
// 'personalizado' e o plano sob medida, acima do Expansao (adminPlan.js):
// barra-lo prenderia cliente grande fora do Studio.
const STUDIO_PLANS = ['negocio', 'expansao', 'personalizado'];

// Chave de pdv_settings ligada por cada frente/extra. Todas estao na
// whitelist ALLOWED_BOOL_KEYS de routes/pdvSettings.js.
const FLAG_BY_SEGMENT = {
  matcon: 'matcon_enabled',
  otica: 'otica_enabled',
  assistencia: 'os_enabled',
};
const FLAG_BY_EXTRA = { os: 'os_enabled' };
const FLAG_BY_DISABLE = { matcon: 'matcon_enabled', otica: 'otica_enabled', os: 'os_enabled' };
// Flag que pertence so a frente (some quando a frente muda). os_enabled fica
// de fora de proposito: e o extra "Ordem de Servico", que vale em qualquer frente.
const OWN_FLAG_BY_SEGMENT = { matcon: 'matcon_enabled', otica: 'otica_enabled' };

// Subclasse CNAE (7 digitos) -> frente. Descricoes oficiais do IBGE.
const CNAE_SUBCLASS_SEGMENT = {
  // Otica
  '4774100': 'otica',       // Comercio varejista de artigos de optica
  // Materiais de construcao (classe 4744-0 inteira + 4741/4742/4743)
  '4744001': 'matcon',      // ... de ferragens e ferramentas
  '4744002': 'matcon',      // ... de madeira e artefatos
  '4744003': 'matcon',      // ... de materiais hidraulicos
  '4744004': 'matcon',      // ... de cal, areia, pedra britada, tijolos e telhas
  '4744005': 'matcon',      // ... de materiais de construcao nao especificados anteriormente
  '4744006': 'matcon',      // ... de pedras para revestimento
  '4744099': 'matcon',      // ... de materiais de construcao em geral
  '4741500': 'matcon',      // ... de tintas e materiais para pintura
  '4742300': 'matcon',      // ... de material eletrico
  '4743100': 'matcon',      // ... de vidros
  // Assistencia tecnica
  '9511800': 'assistencia', // Reparacao e manutencao de computadores e perifericos
  '9512600': 'assistencia', // Reparacao e manutencao de equipamentos de comunicacao
  '9521500': 'assistencia', // Reparacao e manutencao de eletroeletronicos de uso pessoal e domestico
  '4752100': 'assistencia', // Varejo especializado de equipamentos de telefonia e comunicacao
  // Personalizados (Studio)
  '1813001': 'studio',      // Impressao de material para uso publicitario
  '1813099': 'studio',      // Impressao de material para outros usos
  '1340501': 'studio',      // Estamparia e texturizacao em fios, tecidos, artefatos texteis e pecas do vestuario
  // Varejo comum
  '4781400': 'varejo',      // Artigos do vestuario e acessorios
  '4782201': 'varejo',      // Calcados
  '4782202': 'varejo',      // Artigos de viagem
  '4783101': 'varejo',      // Artigos de joalheria
  '4783102': 'varejo',      // Artigos de relojoaria
  '4772500': 'varejo',      // Cosmeticos, perfumaria e higiene pessoal
  '4763601': 'varejo',      // Brinquedos e artigos recreativos
  '4763602': 'varejo',      // Artigos esportivos
  '4761003': 'varejo',      // Artigos de papelaria
  '4755501': 'varejo',      // Tecidos
  '4755502': 'varejo',      // Artigos de armarinho
  '4755503': 'varejo',      // Artigos de cama, mesa e banho
  '4789001': 'varejo',      // Suvenires, bijuterias e artesanatos
  '4789099': 'varejo',      // Outros produtos nao especificados anteriormente
  '4754701': 'varejo',      // Moveis
  '4753900': 'varejo',      // Eletrodomesticos e equipamentos de audio e video
  '4759899': 'varejo',      // Outros artigos de uso pessoal e domestico n.e.
};

function normalizeCnae(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') raw = raw.code || raw.codigo || raw.subclasse || raw.id || '';
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 7 ? digits : null;
}

function segmentOfCnae(raw) {
  const code = normalizeCnae(raw);
  return code ? (CNAE_SUBCLASS_SEGMENT[code] || null) : null;
}

// O CNAE principal decide (inclusive 'varejo'). So quando ele nao e
// reconhecido, os secundarios contam: primeiro uma frente especifica
// (na ordem em que vieram), depois 'varejo'. Nada reconhecido -> null.
function suggestSegmentFromCnae(cnaePrincipal, cnaesSecundarios) {
  const fromPrincipal = segmentOfCnae(cnaePrincipal);
  if (fromPrincipal) return fromPrincipal;
  const secs = Array.isArray(cnaesSecundarios) ? cnaesSecundarios.map(segmentOfCnae).filter(Boolean) : [];
  return secs.find((s) => s !== 'varejo') || (secs.includes('varejo') ? 'varejo' : null);
}

function isValidSegment(s) { return typeof s === 'string' && SEGMENTS.includes(s); }

// Ativa/desativa a vertical da empresa. Extraido de adminVertical.js (mesmas
// queries, mesma ordem). `bestEffortSync` reproduz o comportamento da rota
// admin, que roda fora de transacao e engole falha na sincronizacao do
// studio_enabled; dentro de transacao (applySegment) o erro sobe.
async function setCompanyVertical(conn, companyId, vertical, oldVertical, { bestEffortSync = false } = {}) {
  const { rows } = await conn.query(
    `UPDATE companies
     SET vertical_active = $1,
         vertical_enabled_at = CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING id, plan, trade_name, vertical_active, vertical_enabled_at, pdv_settings`,
    [vertical, companyId]
  );

  const sync = async () => {
    if (vertical === 'studio') {
      await conn.query(
        `UPDATE companies
           SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                             || jsonb_build_object('studio_enabled', true)
         WHERE id = $1`,
        [companyId]
      );
    } else if (oldVertical === 'studio') {
      // desativando o studio — desliga o toggle pra nao vazar telas
      await conn.query(
        `UPDATE companies
           SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                             || jsonb_build_object('studio_enabled', false)
         WHERE id = $1`,
        [companyId]
      );
    }
  };
  if (bestEffortSync) {
    try { await sync(); } catch (err) {
      console.warn('[admin/vertical] sync studio_enabled falhou:', err.message);
    }
  } else {
    await sync();
  }
  return rows[0];
}

function studioPlanError(plan) {
  const err = new AppError(
    'A frente Personalizados (Studio) so pode ser ativada nos planos Negocio, Expansao ou Personalizado. Plano atual: ' + (plan || 'essencial') + '.',
    409
  );
  err.code = 'STUDIO_PLAN_REQUIRED';
  return err;
}

function canHaveStudio(plan) { return STUDIO_PLANS.includes(plan); }

function shapeState(row) {
  const s = (row && row.pdv_settings) || {};
  return {
    segment: row.segment || null,
    segment_source: row.segment_source || null,
    vertical_active: row.vertical_active || null,
    flags: {
      matcon_enabled: s.matcon_enabled === true,
      otica_enabled: s.otica_enabled === true,
      os_enabled: s.os_enabled === true,
      studio_enabled: s.studio_enabled === true,
    },
  };
}

// Grava a frente e liga o que corresponde. `client` deve estar numa
// transacao aberta pelo chamador (register / rota staff).
//   segment  — obrigatorio, da lista SEGMENTS
//   extras   — subconjunto de ['os']
//   source   — 'cnae' | 'landing' | 'user' | 'staff'
//   disable  — so com source 'staff': subconjunto de ['matcon','otica','os']
//   meta     — { segment_suggested, cnae_principal, cnae_descricao } (opcional)
//   replacePrevious — troca de frente: desliga o que era so da frente anterior
//              (ver cabecalho). `extras` undefined = nao mexe em os_enabled.
async function applySegment(client, companyId, { segment, extras, source = 'user', disable = [], meta = null, replacePrevious = false } = {}) {
  if (!isValidSegment(segment)) throw new AppError('Frente invalida. Use uma de: ' + SEGMENTS.join(', '), 400);
  if (!SEGMENT_SOURCES.includes(source)) throw new AppError('Origem da frente invalida', 400);
  const extrasList = Array.isArray(extras) ? extras : [];
  if (extrasList.some((e) => !ALLOWED_EXTRAS.includes(e))) throw new AppError('Recurso extra invalido. Use: ' + ALLOWED_EXTRAS.join(', '), 400);
  const disableList = Array.isArray(disable) ? disable : [];
  if (disableList.length && source !== 'staff') throw new AppError('Somente a equipe Aura pode desligar recursos', 403);
  if (disableList.some((d) => !DISABLEABLE.includes(d))) throw new AppError('disable aceita: ' + DISABLEABLE.join(', '), 400);

  const { rows } = await client.query(
    'SELECT id, plan, vertical_active, pdv_settings, segment FROM companies WHERE id = $1 FOR UPDATE',
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  const company = rows[0];

  const turnOn = new Set();
  if (FLAG_BY_SEGMENT[segment]) turnOn.add(FLAG_BY_SEGMENT[segment]);
  for (const e of extrasList) turnOn.add(FLAG_BY_EXTRA[e]);
  const turnOff = new Set(disableList.map((d) => FLAG_BY_DISABLE[d]));
  for (const f of turnOff) {
    if (turnOn.has(f)) throw new AppError('Nao da para ligar e desligar o mesmo recurso (' + f + ')', 400);
  }
  if (replacePrevious) {
    const ownPrev = company.segment !== segment ? OWN_FLAG_BY_SEGMENT[company.segment] : null;
    if (ownPrev && !turnOn.has(ownPrev)) turnOff.add(ownPrev);
    // Lista vazia explicita = "sem Ordem de Servico". Assistencia vive de OS:
    // ali a frente manda e o extra vazio nao desliga.
    if (Array.isArray(extras) && extras.length === 0 && !turnOn.has('os_enabled')) turnOff.add('os_enabled');
  }

  if (segment === 'studio') {
    if (!canHaveStudio(company.plan)) throw studioPlanError(company.plan);
    if (company.vertical_active !== 'studio') {
      await setCompanyVertical(client, companyId, 'studio', company.vertical_active);
    }
  } else if (company.vertical_active === 'studio' && (source === 'staff' || replacePrevious)) {
    // Troca explicita (equipe, ou o cliente em Configuracoes) saindo do
    // Studio: desativa a vertical.
    await setCompanyVertical(client, companyId, null, 'studio');
  }

  const patch = {};
  for (const f of turnOn) patch[f] = true;
  for (const f of turnOff) patch[f] = false;

  const m = meta || {};
  const { rows: updated } = await client.query(
    `UPDATE companies
        SET segment = $2,
            segment_source = $3,
            segment_suggested = CASE WHEN $5 THEN $6 ELSE segment_suggested END,
            cnae_principal    = CASE WHEN $5 THEN $7 ELSE cnae_principal END,
            cnae_descricao    = CASE WHEN $5 THEN $8 ELSE cnae_descricao END,
            pdv_settings = COALESCE(pdv_settings, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, segment, segment_source, vertical_active, pdv_settings`,
    [
      companyId, segment, source, JSON.stringify(patch),
      !!meta, m.segment_suggested || null, m.cnae_principal || null, m.cnae_descricao || null,
    ]
  );
  return shapeState(updated[0]);
}

module.exports = {
  SEGMENTS,
  SEGMENT_SOURCES,
  ALLOWED_EXTRAS,
  DISABLEABLE,
  STUDIO_PLANS,
  CNAE_SUBCLASS_SEGMENT,
  normalizeCnae,
  suggestSegmentFromCnae,
  isValidSegment,
  canHaveStudio,
  studioPlanError,
  setCompanyVertical,
  applySegment,
  shapeState,
};
