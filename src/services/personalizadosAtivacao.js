// ============================================================
// AURA. — Data em que a frente Personalizados foi ligada (p-172, 17/11/2026)
//
// pdv_settings.personalizados_ativado_em (texto ISO 8601, UTC).
//
// Para que serve: a Fila de producao do Negocio (aura-app#1271,
// components/personalizados/regrasDaProducao.ts) tira da Fila a venda do
// Caixa parada em "Aguardando arte" que foi criada ANTES desta data. O
// trigger trg_sales_studio_status marca toda venda do Caixa com produto
// personalizavel, com a frente ligada ou nao; sem o corte, a loja que liga a
// frente abriria a Fila com meses de vendas antigas, ja entregues de fato.
// Sem a data, o app nao corta nada (escolha conservadora).
//
// Regras:
//   1. A data e gravada na PRIMEIRA vez que a frente fica ligada
//      (studio_enabled passa de desligado para ligado). Frente ligada aqui e
//      o efetivo do backend: studio_enabled === true OU vertical_active =
//      'studio' (o GET /pdv-settings devolve true para a vertical Studio,
//      routes/pdvSettings.js applyVerticalInvariants).
//   2. Nunca sobrescreve: com uma data ja gravada, nada muda. Desligar e
//      ligar de novo mantem a primeira data. A guarda vive no SQL, entao
//      duas gravacoes concorrentes nao trocam a data.
//   3. Somente leitura para o lojista: o PUT /pdv-settings ignora a chave
//      no corpo e preserva a que esta no banco.
//   4. Empresa que JA estava ligada antes deste codigo nao ganha data
//      nenhuma por caminho normal (nao ha transicao). Ela recebe a data
//      original pela migracao (fase 4), com gravarDataOriginalDoStudio.
//
// Quem grava hoje:
//   - services/segment.js setCompanyVertical (vertical Studio ligada pelo
//     cadastro, pela frente 'studio' do applySegment ou pela equipe em
//     /admin/clients/:cid/vertical);
//   - routes/pdvSettings.js PUT (studio_enabled ligado pelas configuracoes).
// Quem for ligar a frente por outro caminho (fase 4: a frente 'studio' so
// com o modulo, no Negocio) usa marcaDaAtivacao + sqlMarcaSeAusente.
// ============================================================
'use strict';

const CHAVE = 'personalizados_ativado_em';

// Texto ISO que o Date entende. Qualquer outra coisa (null, '', boolean,
// "ontem") conta como "sem data", igual ao app (dataDeAtivacao).
function dataValida(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

// Ha algo gravado na chave? Mesmo um valor ruim conta: a regra e nunca
// trocar o que esta no banco (o SQL usa a mesma conta: NULLIF(.., '')).
function temValorGravado(v) {
  return v !== undefined && v !== null && v !== '';
}

function frenteLigada(settings, verticalActive) {
  if (verticalActive === 'studio') return true;
  return !!settings && settings.studio_enabled === true;
}

// A data a gravar agora, ou null. So ha data quando a frente estava
// desligada, fica ligada e ainda nao tem nada guardado na chave.
function marcaDaAtivacao({ antes, verticalAntes = null, ligadaDepois, agora = new Date() } = {}) {
  if (!ligadaDepois) return null;
  if (frenteLigada(antes, verticalAntes)) return null;
  if (antes && temValorGravado(antes[CHAVE])) return null;
  return agora.toISOString();
}

// Fragmento jsonb para concatenar (||) num UPDATE de companies: grava o
// parametro `ref` (texto ISO ou NULL) so quando o banco nao tem a chave.
// Dentro do SET, pdv_settings e o valor ANTES do UPDATE.
function sqlMarcaSeAusente(ref) {
  return `(CASE WHEN ${ref}::text IS NOT NULL
                 AND NULLIF(COALESCE(pdv_settings, '{}'::jsonb)->>'${CHAVE}', '') IS NULL
            THEN jsonb_build_object('${CHAVE}', ${ref}::text)
            ELSE '{}'::jsonb END)`;
}

// Fragmento jsonb para concatenar (||) no fim de um UPDATE que troca o
// pdv_settings inteiro: devolve a data que o banco ja tem, para que ela
// vença qualquer valor do lado de fora (nunca apagada, nunca trocada).
const SQL_PRESERVA_DATA = `(CASE WHEN NULLIF(pdv_settings->>'${CHAVE}', '') IS NOT NULL
            THEN jsonb_build_object('${CHAVE}', pdv_settings->'${CHAVE}')
            ELSE '{}'::jsonb END)`;

// ── Migracao (fase 4): data original de quem ja usa o Studio ─────────────
//
// Para a empresa que vem do /studio, a data e o inicio do uso do Studio:
// a MAIS ANTIGA entre a criacao da empresa e o primeiro pedido da view
// studio_orders (Caixa, loja online e marketplace). Assim o corte nao
// esconde nenhum pedido que o quadro do Studio mostrava. Nao roda sozinho:
// quem migra chama empresa por empresa, com OK do Caio.

// Pura: escolhe a mais antiga das datas validas. Sem nenhuma, null.
function escolherDataOriginal({ empresaCriadaEm, primeiroPedidoEm } = {}) {
  const candidatos = [
    ['primeiro_pedido', primeiroPedidoEm],
    ['empresa', empresaCriadaEm],
  ]
    .map(([origem, v]) => [origem, v instanceof Date ? v : (v ? new Date(v) : null)])
    .filter(([, d]) => d && !Number.isNaN(d.getTime()));
  if (!candidatos.length) return null;
  // Empate: fica a empresa (a origem mais estavel).
  candidatos.sort((a, b) => a[1] - b[1] || (a[0] === 'empresa' ? -1 : 1));
  const [origem, d] = candidatos[0];
  return { data: d.toISOString(), origem };
}

// So leitura. Devolve o retrato da empresa e a data que a migracao gravaria.
async function inicioDoUsoDoStudio(conn, companyId) {
  const { rows } = await conn.query(
    `SELECT c.id, c.created_at, c.vertical_active, c.pdv_settings,
            (SELECT MIN(o.created_at) FROM studio_orders o WHERE o.company_id = c.id) AS primeiro_pedido_em
       FROM companies c
      WHERE c.id = $1`,
    [companyId]
  );
  if (!rows.length) return null;
  const c = rows[0];
  const settings = c.pdv_settings || {};
  const escolha = escolherDataOriginal({ empresaCriadaEm: c.created_at, primeiroPedidoEm: c.primeiro_pedido_em });
  return {
    company_id: c.id,
    ligada: frenteLigada(settings, c.vertical_active),
    data_gravada: settings[CHAVE] ?? null,
    data_original: escolha ? escolha.data : null,
    origem: escolha ? escolha.origem : null,
  };
}

// Grava a data original. Nunca sobrescreve e so grava em empresa com a
// frente ligada. Devolve { gravada, motivo, data }.
async function gravarDataOriginalDoStudio(conn, companyId) {
  const retrato = await inicioDoUsoDoStudio(conn, companyId);
  if (!retrato) return { gravada: false, motivo: 'empresa_nao_encontrada', data: null };
  if (!retrato.ligada) return { gravada: false, motivo: 'frente_desligada', data: null };
  if (temValorGravado(retrato.data_gravada)) {
    return { gravada: false, motivo: 'ja_tem_data', data: retrato.data_gravada };
  }
  if (!retrato.data_original) return { gravada: false, motivo: 'sem_data', data: null };

  const { rows } = await conn.query(
    `UPDATE companies
        SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb) || jsonb_build_object('${CHAVE}', $2::text),
            updated_at = NOW()
      WHERE id = $1
        AND NULLIF(COALESCE(pdv_settings, '{}'::jsonb)->>'${CHAVE}', '') IS NULL
        AND (COALESCE(pdv_settings->>'studio_enabled', '') = 'true' OR vertical_active = 'studio')
      RETURNING pdv_settings->>'${CHAVE}' AS data`,
    [companyId, retrato.data_original]
  );
  // Outra gravacao entrou entre a leitura e o UPDATE: a guarda segurou.
  if (!rows.length) return { gravada: false, motivo: 'ja_tem_data', data: null };
  return { gravada: true, motivo: retrato.origem, data: rows[0].data };
}

module.exports = {
  CHAVE,
  dataValida,
  temValorGravado,
  frenteLigada,
  marcaDaAtivacao,
  sqlMarcaSeAusente,
  SQL_PRESERVA_DATA,
  escolherDataOriginal,
  inicioDoUsoDoStudio,
  gravarDataOriginalDoStudio,
};
