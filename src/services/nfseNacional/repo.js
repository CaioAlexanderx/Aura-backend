// ============================================================
// AURA. — nfseNacional/repo: TODO o SQL do emissor nacional num lugar só.
// O orquestrador (index.js) não escreve SQL; os testes de unidade trocam
// este módulo por um banco em memória e o teste *.banco roda o SQL real
// no Postgres do CI (migration 429 aplicada).
// ============================================================
'use strict';

const { getCertificateInfo } = require('../sefazSp/certStore');
const { lerNfse } = require('./nfseParser');
const { productVisibilityWhere } = require('../../utils/companyGroup');

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

const COLS = `id, company_id, status, provider, idempotency_key, idempotency_fingerprint,
  dps_serie, dps_number, dps_id, chave_acesso, nfse_number, ambiente, competence_date,
  service_code, service_description, service_amount, iss_rate, iss_value, net_amount,
  recipient_name, recipient_doc, rejection_reason, error_codes, transmitted_at, issued_at,
  cancelled_at, cancel_reason, created_at, updated_at`;

async function buscarPorChave(db, companyId, key) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM nfse WHERE company_id = $1 AND idempotency_key = $2`,
    [companyId, key]
  );
  return rows[0] || null;
}

async function buscarPorId(db, companyId, nfseId) {
  const { rows } = await db.query(
    `SELECT ${COLS}, xml_dps, xml_nfse, dps_dados FROM nfse WHERE id = $1 AND company_id = $2`,
    [nfseId, companyId]
  );
  return rows[0] || null;
}

async function carregarContexto(db, companyId) {
  const { rows: cfg } = await db.query('SELECT * FROM nfse_config WHERE company_id = $1', [companyId]);
  // SELECT *: município, UF, ibge_code e tax_regime alimentam a sugestão da
  // tela de configuração; nem toda base tem todas essas colunas (o schema
  // de teste do CI não tem ibge_code), então nada aqui cita coluna opcional.
  const { rows: comp } = await db.query(
    'SELECT *, COALESCE(trade_name, legal_name) AS nome FROM companies WHERE id = $1',
    [companyId]
  );
  let certInfo = null;
  try {
    certInfo = await getCertificateInfo(db, companyId);
  } catch (err) {
    if (err.code !== '42P01') throw err; // cofre ainda não criado = sem certificado
  }
  const config = cfg[0] || null;
  if (config) config.ultimo_teste_error_codes = await errosDoUltimoTeste(db, companyId, config);
  return { config, company: comp[0] || null, certInfo };
}

/**
 * error_codes ([{ codigo, descricao }]) da última nota de teste rejeitada
 * (nfse_config.ultimo_teste_nfse_id). O passo "teste" decide por eles se a
 * rejeição é só do ambiente de testes (E0312). null fora desse caso.
 */
async function errosDoUltimoTeste(db, companyId, config) {
  if (config.ultimo_teste_status !== 'rejeitado' || !config.ultimo_teste_nfse_id) return null;
  const { rows } = await db.query(
    'SELECT error_codes FROM nfse WHERE id = $1 AND company_id = $2',
    [config.ultimo_teste_nfse_id, companyId]
  );
  return rows[0] ? rows[0].error_codes || null : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS_ITEM_NFSE = `nfse_ctribnac, nfse_cnbs, nfse_ctribmun, nfse_aliquota_iss, nfse_descricao,
  ibscbs_cst, ibscbs_cclasstrib, ibscbs_cindop`;

/**
 * Item do estoque (serviço) citado pela nota, com os campos de NFS-e
 * (migration 437). Lido pela MESMA regra de visibilidade do Estoque e do
 * Caixa (productVisibilityWhere): o item compartilhado do grupo
 * (is_group_shared) vale para qualquer empresa do grupo — ler com
 * `company_id = $2` repetiria o erro da NFC-e, que não achava o item
 * compartilhado vendido por outra empresa do grupo. Item arquivado
 * (is_active = false) não vale.
 * Base sem a 437 (42703): devolve o item sem os campos (a nota usa o nome
 * e o padrão da empresa) em vez de derrubar a emissão.
 * @returns {object|null} null = não existe ou não é visível para a empresa
 */
async function buscarItem(db, companyId, productId) {
  if (!UUID_RE.test(String(productId || ''))) return null;
  const where = `id = $1 AND is_active IS NOT FALSE AND ${productVisibilityWhere('$2')}`;
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, name, unit, ${COLS_ITEM_NFSE} FROM products WHERE ${where}`,
      [productId, companyId]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code !== '42703') throw err;
    console.warn('[nfse nacional] item sem os campos de NFS-e: base sem a migration 437');
    const { rows } = await db.query(
      `SELECT id, company_id, name, unit FROM products WHERE ${where}`,
      [productId, companyId]
    );
    return rows[0] || null;
  }
}

/**
 * Reserva o próximo nDPS e grava a nota 'pendente', numa transação só.
 * @returns {{ row } | { corrida: true }} corrida = outra requisição com a
 *   mesma chave gravou antes (o número reservado aqui volta no ROLLBACK).
 */
async function reservar(db, { companyId, key, fp, entrada, nota, ambiente, serieTeste = null }) {
  const cx = await db.connect();
  try {
    await cx.query('BEGIN');
    // Nota de teste (migration 441): contador próprio e série fixa — nunca
    // toca next_dps_number, a numeração de verdade da loja.
    const contador = serieTeste ? 'teste_next_dps_number' : 'next_dps_number';
    const { rows: num } = await cx.query(
      `UPDATE nfse_config SET ${contador} = ${contador} + 1
        WHERE company_id = $1
        RETURNING ${contador} - 1 AS n, serie`,
      [companyId]
    );
    if (!num[0]) {
      await cx.query('ROLLBACK');
      return { semConfig: true };
    }
    const serie = serieTeste || String(parseInt(onlyDigits(num[0].serie || '1'), 10) || 1);
    const t = entrada.tomador;
    const { rows } = await cx.query(
      `INSERT INTO nfse (
         company_id, customer_id, payment_id, source_type, provider, status, ambiente,
         idempotency_key, idempotency_fingerprint, dps_serie, dps_number, dps_dados,
         recipient_type, recipient_name, recipient_doc, recipient_email, recipient_phone, recipient_address,
         service_code, service_description, service_amount, iss_rate, iss_value, iss_retained,
         net_amount, competence_date
       ) VALUES (
         $1, $2, $3, $4, 'nacional', 'pendente', $5,
         $6, $7, $8, $9, $10::jsonb,
         $11, $12, $13, $14, $15, $16::jsonb,
         $17, $18, $19, $20, 0, $21,
         $19, $22
       ) RETURNING ${COLS}`,
      [
        companyId, nota.customer_id || null, nota.payment_id || null, nota.source_type || 'manual', ambiente,
        key, fp, serie, String(num[0].n), JSON.stringify(entrada),
        t && onlyDigits(t.doc).length === 14 ? 'pj' : 'pf',
        t ? t.nome : null, t ? onlyDigits(t.doc) : null, t ? (t.email || null) : null, t ? (t.fone || null) : null,
        t && t.endereco ? JSON.stringify(t.endereco) : null,
        entrada.servico.cTribNac, entrada.servico.descricao, Number(entrada.valores.vServ),
        Number(entrada.valores.pAliq || 0), Number(entrada.valores.tpRetISSQN) === 2,
        entrada.dCompet,
      ]
    );
    await cx.query('COMMIT');
    return { row: rows[0] };
  } catch (err) {
    try { await cx.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err && err.code === '23505' && /idempotency/.test(String(err.constraint || err.detail || err.message))) {
      return { corrida: true };
    }
    throw err;
  } finally {
    cx.release();
  }
}

/** XML assinado + transmitted_at gravados ANTES do POST. */
async function marcarTransmitindo(db, id, { idDps, xml }) {
  await db.query(
    `UPDATE nfse SET dps_id = $1, xml_dps = $2, transmitted_at = NOW(), status = 'pendente', rejection_reason = NULL
      WHERE id = $3`,
    [idDps, xml, id]
  );
}

async function marcarSemConfirmacao(db, id, mensagem) {
  await db.query('UPDATE nfse SET rejection_reason = $1 WHERE id = $2', [String(mensagem).slice(0, 1000), id]);
}

async function marcarErro(db, id, mensagem, codigos = null) {
  await db.query(
    `UPDATE nfse SET status = 'erro', rejection_reason = $1, error_codes = COALESCE($2::jsonb, error_codes)
      WHERE id = $3 AND status IN ('pendente', 'erro')`,
    [String(mensagem).slice(0, 1000), codigos ? JSON.stringify(codigos) : null, id]
  );
}

/**
 * A DPS da Aura caiu numa série/número que outro emissor da empresa já usou
 * (incidente de 10/11/2026). A nota vira 'erro' com o código próprio; a
 * NFS-e devolvida fica SÓ como evidência em provider_response.
 * nfse_de_outro_emissor — nunca em xml_nfse, chave_acesso ou nfse_number.
 * bloquearConfig: marca o conflito em nfse_config (migration 443) para a
 * Aura não gastar mais números até a loja conferir a série e o último
 * número. Base sem a 443: só a nota é marcada.
 * @returns {boolean} true = a nota foi marcada (estava pendente/erro)
 */
async function marcarNumeroJaUsado(db, row, { mensagem, evidencia, bloquearConfig = true }) {
  const { rowCount } = await db.query(
    `UPDATE nfse SET status = 'erro', rejection_reason = $1, error_codes = $2::jsonb,
            provider_response = COALESCE(provider_response, '{}'::jsonb) || $3::jsonb
      WHERE id = $4 AND status IN ('pendente', 'erro')`,
    [
      String(mensagem).slice(0, 1000),
      JSON.stringify([{ codigo: 'DPS_NUMERO_JA_USADO', descricao: String(mensagem).slice(0, 500) }]),
      JSON.stringify({ nfse_de_outro_emissor: evidencia || {} }),
      row.id,
    ]
  );
  if (!rowCount || !bloquearConfig) return rowCount > 0;
  try {
    await db.query(
      `UPDATE nfse_config SET dps_conflito_em = NOW(), dps_conflito_serie = $1, dps_conflito_numero = $2
        WHERE company_id = $3`,
      [row.dps_serie != null ? String(row.dps_serie) : null, row.dps_number != null ? String(row.dps_number) : null, row.company_id]
    );
  } catch (err) {
    if (err.code !== '42703') throw err;
    console.warn('[nfse nacional] conflito de numeração não gravado na config: base sem a migration 443');
  }
  return true;
}

/**
 * Guarda do SQL de gravarAutorizada (incidente de 10/11/2026): só uma nota
 * ainda aberta ('pendente'/'erro') vira autorizada, e nunca uma nota que a
 * Aura já conferiu como de OUTRO emissor (DPS_NUMERO_JA_USADO em
 * error_codes ou no começo de rejection_reason — mesma regra de
 * errors.temDpsNumeroJaUsado). Assim um "Tentar de novo" com uma leitura
 * antiga da nota não readota a NFS-e alheia nem apaga a evidência.
 */
const SO_NOTA_ABERTA_DA_AURA = `status IN ('pendente', 'erro')
        AND NOT (COALESCE(error_codes, '[]'::jsonb) @> '[{"codigo":"DPS_NUMERO_JA_USADO"}]'::jsonb)
        AND ltrim(COALESCE(rejection_reason, '')) NOT LIKE 'DPS\\_NUMERO\\_JA\\_USADO%'`;

/**
 * Grava a NFS-e como autorizada — só se a guarda deixar (SO_NOTA_ABERTA_DA_AURA).
 * provider_response é MESCLADO (||): a evidência gravada antes fica.
 * @returns {{ gravada: boolean, nota: object|null }} sem linha afetada não
 *   lança: devolve a nota como está no banco
 */
async function gravarAutorizada(db, id, { chaveAcesso, nfseXml, alertas, cabecalho }) {
  let lido;
  try { lido = lerNfse(nfseXml); } catch (_) { lido = { valores: {} }; }
  const v = lido.valores || {};
  const { rows } = await db.query(
    `UPDATE nfse SET
        status = 'autorizada',
        chave_acesso = $1,
        provider_id = $1,
        nfse_number = $2,
        xml_nfse = $3,
        issued_at = COALESCE($4::timestamptz, NOW()),
        iss_value = COALESCE($5, iss_value),
        iss_rate = COALESCE($6, iss_rate),
        net_amount = COALESCE($7, net_amount),
        rejection_reason = NULL,
        error_codes = NULL,
        provider_response = COALESCE(provider_response, '{}'::jsonb) || $8::jsonb
      WHERE id = $9
        AND ${SO_NOTA_ABERTA_DA_AURA}
      RETURNING ${COLS}`,
    [
      chaveAcesso || lido.chaveAcesso, lido.nNFSe || null, nfseXml, lido.dhProc || null,
      v.vISSQN, v.pAliqAplic, v.vLiq,
      JSON.stringify({ alertas: alertas || [], cabecalho: cabecalho || {}, cStat: lido.cStat || null }),
      id,
    ]
  );
  if (rows && rows[0]) return { gravada: true, nota: rows[0] };
  const { rows: atual } = await db.query(`SELECT ${COLS} FROM nfse WHERE id = $1`, [id]);
  return { gravada: false, nota: (atual && atual[0]) || null };
}

async function gravarRejeitada(db, id, { texto, erros, cabecalho }) {
  await db.query(
    `UPDATE nfse SET status = 'rejeitada', rejection_reason = $1, error_codes = $2::jsonb,
            provider_response = COALESCE(provider_response, '{}'::jsonb) || $3::jsonb
      WHERE id = $4`,
    [String(texto || 'Rejeitada pelo Sistema Nacional').slice(0, 2000), JSON.stringify(erros || []), JSON.stringify({ cabecalho: cabecalho || {} }), id]
  );
}

async function gravarCancelada(db, id, { motivo, eventoXml }) {
  await db.query(
    `UPDATE nfse SET status = 'cancelada', cancelled_at = COALESCE(cancelled_at, NOW()),
            cancel_reason = COALESCE($1, cancel_reason), cancel_event_xml = $2
      WHERE id = $3`,
    [motivo || null, eventoXml || null, id]
  );
}

async function gravarCancelamentoRecusado(db, id, erros) {
  await db.query(
    `UPDATE nfse SET provider_response = COALESCE(provider_response, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ cancelamento_recusado: erros || [] }), id]
  );
}

/**
 * Resultado da última nota de teste (migration 441). Gravado a cada teste,
 * para um teste diário futuro (depois do E0084) só precisar ler daqui.
 */
async function gravarResultadoTeste(db, companyId, { status, codigo, mensagem, nfseId }) {
  await db.query(
    `UPDATE nfse_config SET ultimo_teste_em = NOW(), ultimo_teste_status = $1, ultimo_teste_codigo = $2,
            ultimo_teste_mensagem = $3, ultimo_teste_nfse_id = $4
      WHERE company_id = $5`,
    [status, codigo || null, mensagem ? String(mensagem).slice(0, 1000) : null, nfseId || null, companyId]
  );
}

/** XML novo da NFS-e (consulta pela chave): só de nota autorizada/cancelada. */
async function atualizarXmlNfse(db, id, xml) {
  await db.query(
    "UPDATE nfse SET xml_nfse = $1 WHERE id = $2 AND status IN ('autorizada', 'cancelada')",
    [xml, id]
  );
}

/** Junta uma evidência em provider_response sem apagar o que já está lá. */
async function anexarEvidencia(db, id, evidencia) {
  await db.query(
    `UPDATE nfse SET provider_response = COALESCE(provider_response, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify(evidencia || {}), id]
  );
}

/**
 * Notas de PRODUÇÃO da loja que já saíram (sem as de teste), as mais novas
 * primeiro — para a regra da série antes da primeira nota de verdade
 * (config.pendenciaDaSerieAntesDaPrimeiraNota). Traz os XMLs: quem chama
 * confere se a nota autorizada é mesmo da DPS que a Aura assinou.
 */
async function notasDeProducao(db, companyId, limite = 20) {
  const { rows } = await db.query(
    `SELECT id, status, dps_serie, dps_number, error_codes, rejection_reason, xml_dps, xml_nfse
       FROM nfse
      WHERE company_id = $1 AND provider = 'nacional' AND ambiente = 'producao'
        AND source_type IS DISTINCT FROM 'teste' AND transmitted_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [companyId, limite]
  );
  return rows;
}

module.exports = {
  buscarPorChave, buscarPorId, carregarContexto, buscarItem, reservar,
  marcarTransmitindo, marcarSemConfirmacao, marcarErro, marcarNumeroJaUsado,
  gravarAutorizada, gravarRejeitada, gravarCancelada, gravarCancelamentoRecusado, atualizarXmlNfse,
  gravarResultadoTeste, anexarEvidencia, notasDeProducao,
  SO_NOTA_ABERTA_DA_AURA,
};
