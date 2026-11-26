// ============================================================
// AURA — WhatsApp: PRÉVIA e ENVIO das automáticas (tela nova, 26/11/2026)
//
// `previa` não grava nada. `rodar` corta a lista, e para cada pessoa que
// cabe chama waOutbox.enqueue: é o enqueue que RESERVA o saldo na mesma
// transação do INSERT na wa_outbox (waSaldo.reservar, agente A). Aqui não
// existe segundo caminho de saldo: cada origem (aniversario, venda_mais,
// crediario_oferta, crediario) cai no saldo certo pelo source_type.
//
// Duas travas próprias, além das do saldo:
//   - a PARTE da divisão (4/4/2): ninguém passa do que a automática tem;
//   - o teto de 50 por envio.
// Parou de caber (parte, saldo, número em atenção): para ali. Nada de
// "mandar mesmo assim".
// ============================================================
'use strict';

const db = require('../../config/database');
const waOutbox = require('../waOutbox');
const mkt = require('../marketing/marketingCommon');
const publico = require('./publico');
const auto = require('./automaticas');
const modelosCatalogo = require('./modelos');
const modelosStore = require('./modelosStore');

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const ORDEM = Object.freeze({
  padrao: 'quem mais compra primeiro',
  limite: 'quem tem mais limite livre primeiro',
});

function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || 'Cliente'; }
function dataBR(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}`; }
function descreverPresente(p) { return p ? mkt.describeDiscount(p.tipo === 'percent' ? 'percent' : 'fixed', p.valor) : null; }

// "no sábado, 30/11" (futuro), "hoje", "ontem", "no dia 20/11" (atraso).
function textoDeVencimento(dueIso, hojeIso) {
  const dias = Math.round((Date.parse(`${dueIso}T12:00:00Z`) - Date.parse(`${hojeIso}T12:00:00Z`)) / 86400000);
  if (dias === 0) return 'hoje';
  if (dias === -1) return 'ontem';
  if (dias === 1) return `amanhã, ${dataBR(dueIso)}`;
  if (dias < 0) return `no dia ${dataBR(dueIso)}`;
  const sem = DIAS_SEMANA[new Date(`${dueIso}T12:00:00Z`).getUTCDay()];
  return `${dias <= 6 ? `no ${sem}` : 'no dia'}, ${dataBR(dueIso)}`.replace('no dia, ', 'no dia ');
}

// ── modelo escolhido para cada automática ───────────────────
function modeloDoAniversario(config) {
  if (config.presente && config.quando && config.quando !== 'no_dia') return 'aniv_antes';
  return `aniv_${config.tom}_${config.presente ? 'com' : 'sem'}`;
}

// ── dados extras de cada cliente ────────────────────────────
async function ultimaCompra(companyId, customerId) {
  try {
    const { rows } = await db.query(
      `-- wa:auto-ultima-compra
       SELECT COALESCE(NULLIF(p.name, ''), NULL) AS produto
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN products p ON p.id = si.product_id
        WHERE s.company_id = $1 AND s.customer_id = $2
        ORDER BY s.created_at DESC, si.id ASC LIMIT 1`,
      [companyId, customerId]
    );
    return (rows[0] && rows[0].produto) || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

async function cupomVigenteDoAniversario(companyId, customerId) {
  try {
    const { rows } = await db.query(
      `-- wa:auto-cupom-aniversario
       SELECT * FROM coupons
        WHERE company_id = $1 AND customer_id = $2 AND source = 'birthday'
          AND expires_at > NOW() AND created_at > NOW() - INTERVAL '20 days'
        ORDER BY created_at DESC LIMIT 1`,
      [companyId, customerId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

function cupomUsado(c) { return Number(c && (c.current_uses != null ? c.current_uses : c.uses_count)) > 0; }

// ── prévia ──────────────────────────────────────────────────
async function livresDaAutomatica(companyId, key) {
  const [divisao, usadas] = await Promise.all([auto.lerDivisao(companyId), auto.usadasNoMes(companyId)]);
  const parte = auto.PARTE[key];
  return { divisao, usadas, parte, livres: parte ? auto.livresDaParte(divisao, usadas, parte) : 0 };
}

async function previa(companyId, key, { segmento = null, hoje = publico.hojeBRT() } = {}) {
  if (!auto.KEYS.includes(key)) throw new auto.ErroAuto(404, 'AUTOMATICA_DESCONHECIDA', 'Essa automática não existe.');
  const linhas = await auto.lerLinhas(companyId);
  const config = auto.normalizarConfig(key, linhas.get(key) && linhas.get(key).config, segmento ? { segmento } : null);

  if (key === 'crediario_cobrar') return previaCobranca(companyId, config, hoje);

  const { livres, divisao, parte } = await livresDaAutomatica(companyId, key);
  const periodo = publico.mesDe(hoje);

  if (key === 'aniversario') {
    const per = 1;
    const cands = await publico.candidatosAniversario(companyId, Number(periodo.slice(5, 7)));
    const { elegiveis, fora } = await publico.classificarDoBanco(companyId, cands);
    const pessoas = Math.floor(livres / per);
    const r = publico.montarPrevia({
      key, periodo, elegiveis: publico.ordenar(elegiveis), fora, livres: pessoas, ordem: ORDEM.padrao,
      detalhe: (c) => `dia ${c.dia} · ${publico.reais(c.total_spent)} em compras`,
    });
    return { ...r, novidades_por_pessoa: per, novidades_necessarias: elegiveis.length * per, livres, parte: divisao[parte] };
  }

  if (key === 'venda_mais') {
    const cands = await publico.candidatosVendaMais(companyId, config.segmento, hoje);
    const { elegiveis, fora } = await publico.classificarDoBanco(companyId, cands);
    return { ...publico.montarPrevia({
      key, periodo, elegiveis: publico.ordenar(elegiveis), fora, livres, ordem: ORDEM.padrao,
      detalhe: (c) => `${publico.reais(c.total_spent)} em compras · ${c.dias_sem_comprar} dias`,
    }), segmento: config.segmento };
  }

  // crediario_vender
  const cands = await publico.candidatosCrediarioVender(companyId, hoje);
  const { elegiveis, fora } = await publico.classificarDoBanco(companyId, cands);
  return publico.montarPrevia({
    key, periodo, elegiveis: publico.ordenar(elegiveis, 'limite_livre'), fora, livres, ordem: ORDEM.limite,
    detalhe: (c) => `paga em dia há ${Math.max(1, Number(c.relationship_months) || 1)} meses · ${publico.reais(c.limite_livre)} livres`,
  });
}

function pontosLigados(config) {
  return Object.entries(auto.DESLOCAMENTO_COBRANCA).filter(([k]) => config.pontos[k]).map(([k, d]) => ({ ponto: k, deslocamento: d }));
}

async function previaCobranca(companyId, config, hoje) {
  const amanha = publico.somarDias(hoje, 1);
  const pts = pontosLigados(config);
  const parcelas = await publico.parcelasParaCobrar(companyId, amanha, pts.map((p) => p.deslocamento));
  const { elegiveis, fora } = publico.classificar(parcelas.map((p) => ({ ...p, id: p.customer_id })), await optouts(companyId, parcelas));
  let avisosLivres = null;
  try { avisosLivres = (await require('../waSaldo').getSaldos(companyId)).saldos.avisos.restante; } catch (_) { /* a tela mostra sem o número */ }
  return {
    key: 'crediario_cobrar', amanha: {
      data: amanha, saem: elegiveis.length,
      itens: elegiveis.slice(0, 50).map((p) => ({
        customer_id: p.customer_id, nome: p.name, ponto: (pts.find((x) => x.deslocamento === p.deslocamento) || {}).ponto,
        detalhe: `${publico.reais(p.valor)} · parcela ${p.installment_number} de ${p.total_installments}`,
      })),
    },
    fora: publico.contarForas(fora),
    fora_lista: fora.slice(0, 50).map((c) => ({ customer_id: c.customer_id, nome: c.name, motivo: c.motivo })),
    avisos_livres: avisosLivres,
  };
}

async function optouts(companyId, cands) {
  const c = await publico.conjuntosDeBloqueio(companyId, cands);
  return { recentes: new Set(), optouts: c.optouts }; // aviso não tem a regra dos 7 dias
}

// ── envio ───────────────────────────────────────────────────
// Parou de caber: o laço termina na primeira recusa de saldo.
const RECUSAS_QUE_PARAM = new Set(['SALDO_ESGOTADO', 'NUMERO_EM_ATENCAO', 'SALDO_INDISPONIVEL', 'LIMITE_MARKETING']);

async function enfileirar({ companyId, cliente, modeloKey, valores, sourceType, dedupeKey, customerId }) {
  const m = await modelosStore.resolverParaEnvio(companyId, modeloKey);
  if (!m.pronto) return { ok: false, reason: 'MODELO_NAO_APROVADO', para: true };
  const faltando = modelosCatalogo.camposSemValor(m.texto, valores);
  if (faltando.length) return { ok: false, reason: 'CAMPO_SEM_VALOR' };
  const sim = await waOutbox.simulate({
    companyId, toPhone: cliente.fone || cliente.phone, templateName: m.templateName, templateLanguage: m.language,
    sourceType, customerId,
  });
  if (!sim.ok) return { ok: false, reason: sim.reason };
  const r = await waOutbox.enqueue({
    companyId, toPhone: cliente.fone || cliente.phone, kind: 'template',
    templateName: m.templateName, templateLanguage: m.language,
    components: modelosCatalogo.componentesDeEnvio(m.texto, valores),
    sourceType, sourceId: String(customerId), dedupeKey, customerId,
  });
  if (r.queued) return { ok: true, id: r.id };
  return { ok: false, reason: r.reason || 'NAO_ENFILEIRADO', para: RECUSAS_QUE_PARAM.has(r.reason) };
}

function somar(out, reason) { out.puladas[reason] = (out.puladas[reason] || 0) + 1; }

async function criarCupom(companyId, cliente, kind, presente, validadeDias = 15) {
  if (!presente) return null;
  return mkt.createCoupon(companyId, { id: cliente.id, name: cliente.name }, kind, {
    discount_type: presente.tipo, discount_value: presente.valor, validity_days: validadeDias,
  });
}

async function enviarLoteDeNovidade({ companyId, key, lote, config, hoje, modeloDe, valoresDe, sourceType, dedupe, kindCupom, exigeCupom }) {
  const { livres: livresIni, parte } = await livresDaAutomatica(companyId, key);
  const out = { enfileiradas: 0, guardadas: 0, puladas: {}, parou_por: null };
  let livres = livresIni;
  const teto = Math.min(publico.MAX_POR_ENVIO, lote.length);
  for (const cliente of lote.slice(0, teto)) {
    if (livres <= 0) { out.parou_por = 'SEM_SALDO'; break; }
    const modeloKey = modeloDe(cliente);
    let cupom = null;
    if (exigeCupom) {
      cupom = await (kindCupom === 'aniversario' ? cupomVigenteDoAniversario(companyId, cliente.id) : null)
        || await criarCupom(companyId, cliente, kindCupom === 'aniversario' ? mkt.KIND_ANIVERSARIO : mkt.KIND_REATIVACAO, config.presente);
      if (!cupom) { somar(out, 'SEM_CUPOM'); continue; }
    }
    const valores = await valoresDe(cliente, cupom);
    const r = await enfileirar({ companyId, cliente, modeloKey, valores, sourceType, dedupeKey: dedupe(cliente), customerId: cliente.id });
    if (r.ok) {
      out.enfileiradas++; livres--;
      await mkt.logMarketing({ companyId, customerId: cliente.id, kind: sourceType === 'aniversario' ? mkt.KIND_ANIVERSARIO : mkt.KIND_REATIVACAO,
        couponId: cupom ? cupom.id : null, waOutboxId: r.id, refYear: Number(hoje.slice(0, 4)) });
    } else {
      somar(out, r.reason);
      if (r.para) { out.parou_por = r.reason; break; }
    }
  }
  out.guardadas = Math.max(0, lote.length - out.enfileiradas - Object.values(out.puladas).reduce((a, b) => a + b, 0));
  void parte;
  return out;
}

const valoresBase = async (companyId, loja) => ({ 'Nome da loja': loja });

async function rodarVendaMais(companyId, config, hoje, loja) {
  const cands = await publico.candidatosVendaMais(companyId, config.segmento, hoje);
  const { elegiveis } = await publico.classificarDoBanco(companyId, cands);
  const { livres } = await livresDaAutomatica(companyId, 'venda_mais');
  const { vao } = publico.cortar(publico.ordenar(elegiveis), livres);
  const sumiu = config.segmento === 'sumiu';
  return enviarLoteDeNovidade({
    companyId, key: 'venda_mais', lote: vao, config, hoje, sourceType: 'venda_mais', kindCupom: 'reativacao', exigeCupom: !!config.presente,
    modeloDe: () => `venda_${config.segmento}_${config.presente ? 'com' : 'sem'}`,
    dedupe: (c) => `vmais-${c.id}-${publico.mesDe(hoje)}`,
    valoresDe: async (c, cupom) => ({
      ...(await valoresBase(companyId, loja)),
      'Nome': primeiroNome(c.name),
      'Última compra': (await ultimaCompra(companyId, c.id)) || 'uma peça',
      'Mês da última compra': sumiu && c.last_purchase_at ? MESES[new Date(c.last_purchase_at).getUTCMonth()] : '',
      'Presente': descreverPresente(config.presente),
      'Validade': cupom ? mkt.formatDateBR(cupom.expires_at) : '',
    }),
  });
}

async function rodarCrediarioVender(companyId, config, hoje, loja) {
  const cands = await publico.candidatosCrediarioVender(companyId, hoje);
  const { elegiveis } = await publico.classificarDoBanco(companyId, cands);
  const { livres } = await livresDaAutomatica(companyId, 'crediario_vender');
  const { vao } = publico.cortar(publico.ordenar(elegiveis, 'limite_livre'), livres);
  return enviarLoteDeNovidade({
    companyId, key: 'crediario_vender', lote: vao, config, hoje, sourceType: 'crediario_oferta', kindCupom: null, exigeCupom: false,
    modeloDe: () => 'cred_oferta',
    dedupe: (c) => `cred-oferta-${c.id}-${publico.mesDe(hoje)}`,
    valoresDe: async (c) => ({
      ...(await valoresBase(companyId, loja)), 'Nome': primeiroNome(c.name), 'Limite livre': publico.reais(c.limite_livre),
    }),
  });
}

// Aniversário: UMA mensagem por aniversário, no dia que a lojista escolheu
// (no dia, 3 ou 7 dias antes). Entra quem está entre os que CABEM no mês
// (quem mais compra primeiro), não quem faz aniversário primeiro.
async function rodarAniversario(companyId, config, hoje, loja) {
  const divisao = await auto.lerDivisao(companyId);
  const alvo = publico.somarDias(hoje, auto.QUANDO[config.quando || 'no_dia']);
  const cands = await publico.candidatosAniversario(companyId, Number(alvo.slice(5, 7)));
  const { elegiveis } = await publico.classificarDoBanco(companyId, cands);
  const noMes = publico.ordenar(elegiveis).slice(0, divisao.aniversario);
  const lote = noMes.filter((c) => Number(c.dia) === Number(alvo.slice(8, 10)));
  return enviarLoteDeNovidade({
    companyId, key: 'aniversario', lote, config, hoje, sourceType: 'aniversario', kindCupom: 'aniversario', exigeCupom: !!config.presente,
    modeloDe: () => modeloDoAniversario(config),
    dedupe: (c) => `aniv-${c.id}-${alvo.slice(0, 4)}`,
    valoresDe: async (c, cupom) => ({
      ...(await valoresBase(companyId, loja)),
      'Nome': primeiroNome(c.name),
      'Presente': descreverPresente(config.presente),
      'Validade': cupom ? mkt.formatDateBR(cupom.expires_at) : '',
      'Código': cupom ? cupom.code : '',
    }),
  });
}

// Cobrança: AVISOS. Sem corte por quem mais compra (a data é do dia) e sem
// teto de 50 por envio; quem para o laço é o saldo de avisos (reserva no
// enqueue). Quem fica sem aviso vira "Cobrar pelo meu WhatsApp" no app.
async function rodarCobranca(companyId, config, hoje, loja) {
  const out = { enfileiradas: 0, guardadas: 0, puladas: {}, parou_por: null };
  const pts = pontosLigados(config);
  const parcelas = await publico.parcelasParaCobrar(companyId, hoje, pts.map((p) => p.deslocamento));
  for (const p of parcelas) {
    const modeloKey = p.deslocamento > 0 ? 'cred_antes' : (p.deslocamento === 0 ? 'cred_dia' : 'cred_atraso');
    const ponto = (pts.find((x) => x.deslocamento === p.deslocamento) || {}).ponto;
    const valores = {
      'Nome': primeiroNome(p.name), 'Nome da loja': loja,
      'Parcela': `${p.installment_number} de ${p.total_installments}`,
      'Total de parcelas': String(p.total_installments),
      'Valor': publico.reais(p.valor),
      'Vencimento': textoDeVencimento(p.due_iso, hoje),
      'Pix da loja': await pixDaLoja(companyId),
      'Link da loja': '',
    };
    const r = await enfileirar({
      companyId, cliente: p, modeloKey, valores, sourceType: 'crediario',
      dedupeKey: `credaviso-${p.id}-${ponto}`, customerId: p.customer_id,
    });
    if (r.ok) out.enfileiradas++;
    else { somar(out, r.reason); if (r.para) { out.parou_por = r.reason; break; } }
  }
  return out;
}

const _pix = new Map();
async function pixDaLoja(companyId) {
  if (_pix.has(companyId) && Date.now() - _pix.get(companyId).at < 60000) return _pix.get(companyId).v;
  let v = '';
  try {
    const { rows } = await db.query(
      `-- wa:auto-pix
       SELECT pix_key FROM digital_channel_config WHERE company_id = $1`,
      [companyId]
    );
    v = (rows[0] && rows[0].pix_key) || '';
  } catch (_) { v = ''; }
  _pix.set(companyId, { at: Date.now(), v });
  return v;
}

// Trava de novidades por loja: lê "quanto cabe na parte" e enfileira dentro da
// MESMA trava, para dois envios ao mesmo tempo (dois cliques, clique + job)
// não passarem da parte. É um lock próprio, em outra chave que o do saldo
// (wa_saldo:...): o enqueue usa outra conexão e pega o lock do saldo, então
// segurar o MESMO lock aqui travaria o próprio envio. O saldo em si segue
// protegido pelo waSaldo.reservar.
async function comTravaDeNovidades(companyId, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wa_novidades_partes:${companyId}`]);
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão já caiu */ }
    if (e && e.code === '55P03') {
      throw new auto.ErroAuto(409, 'ENVIO_EM_ANDAMENTO', 'Já há um envio desta loja em andamento. Espere terminar e tente de novo.');
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Roda UMA automática de UMA loja. `lista` do cliente nunca entra: o corte
 * é refeito aqui, no servidor.
 */
async function rodar(companyId, key, { hoje = publico.hojeBRT(), segmento = null, ignorarLigada = false } = {}) {
  if (!auto.KEYS.includes(key)) throw new auto.ErroAuto(404, 'AUTOMATICA_DESCONHECIDA', 'Essa automática não existe.');
  const linhas = await auto.lerLinhas(companyId);
  const linha = linhas.get(key);
  if (!ignorarLigada && !(linha && linha.ligada)) return { enfileiradas: 0, guardadas: 0, puladas: {}, parou_por: 'DESLIGADA' };
  const config = auto.normalizarConfig(key, linha && linha.config, segmento ? { segmento } : null);
  const loja = await mkt.loadStoreName(companyId);
  let out;
  if (key === 'crediario_cobrar') out = await rodarCobranca(companyId, config, hoje, loja);
  else {
    const rodador = { aniversario: rodarAniversario, venda_mais: rodarVendaMais, crediario_vender: rodarCrediarioVender }[key];
    out = await comTravaDeNovidades(companyId, () => rodador(companyId, config, hoje, loja));
  }
  await db.query(
    `-- wa:auto-rodada
     UPDATE wa_automaticas SET ultima_rodada_em = NOW() WHERE company_id = $1 AND automatica = $2`,
    [companyId, key]
  ).catch(() => {});
  return out;
}

module.exports = {
  ORDEM, MESES, textoDeVencimento, modeloDoAniversario, primeiroNome, previa, rodar, enfileirar,
};
