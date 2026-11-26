// ============================================================
// AURA. — Ordem de Servico
//
// Montado em private.js sob /service-orders. Schema: migration 313.
//
// GET    /service-orders?status=&days=&limit=&customer_id=&q=  → {orders}
// POST   /service-orders                                       → {order} (status 'aberta')
// GET    /service-orders/:osId                                 → {order, items}
// PATCH  /service-orders/:osId                                 → {order}
// PUT    /service-orders/:osId/items                           → {order, items}
// POST   /service-orders/:osId/approve                         → {order}
// POST   /service-orders/:osId/status                          → {order}
// POST   /service-orders/:osId/lab                             → {order}   (so kind='otica')
// POST   /service-orders/:osId/notify-ready                    → {queued, skip_reason, track_url, wa_link}
// GET    /service-orders/otica-no-caixa?customer_id=           → {orders}  (p-208, faixa do Caixa)
// POST   /service-orders/:osId/receber-saldo                   → {order, paid, remaining, ...} (p-208)
// DELETE /service-orders/:osId                                 → {deleted:true}
//
// A OS NASCE ANTES DA VENDA (decisao de produto, 31/08/2026): ela e aberta na
// ENTRADA do equipamento, quando ainda nao ha venda nenhuma, e so encosta numa
// venda ao ser entregue. Por isso nao ha nada aqui pendurado no fluxo do PDV —
// e o contrario, a venda e que aparece no fim da vida da OS.
//
// KIND (15/09/2026, migration 334): a mesma OS serve a assistencia tecnica
// (kind='reparo', o fluxo original) e a otica (kind='otica', oculos de grau).
// A maquina de status e a mesma; a otica acrescenta a etapa do laboratorio
// (lab_status, coluna propria), o snapshot da receita/armacao/lente em
// `optical` e o sinal (deposit_sale_id). O que muda por kind: o gate, os
// campos obrigatorios na abertura e a regra pra virar 'pronta'.
//
// GATE: os_enabled em companies.pdv_settings pro reparo; otica_enabled pra
// otica (a otica liga sozinha, sem exigir os_enabled). Gate so na ESCRITA —
// ver comentario em assertOsEnabled().
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { urlPublicaDoApp } = require('../utils/urlPublicaDoApp');
const {
  assertOticaEnabled, erroOticaDesligada, carregarOticaSettings, OTICA_DEFAULTS, waParam, primeiroNome,
} = require('./otica');
const waOutbox = require('../services/waOutbox');
// p-208 (23/11/2026): o saldo da OS de otica e quitado no razao do crediario.
const creditLedger = require('../services/creditLedger');
// 24/11/2026: cliente do dono vale em qualquer loja dele (utils/ownerScope.js).
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
// 10/11/2026 (migration 438): NFS-e automatica da OS concluida.
const nfseAutomatica = require('../services/nfseAutomatica');

// ─── Gate do modulo ──────────────────────────────────────────
//
// Le do BANCO, nunca do JWT: o token carrega plano/modulos de quando foi
// emitido e nunca revalida, entao uma loja que acabou de ativar a OS ficaria
// sem o modulo ate deslogar (armadilha #9 do CLAUDE.md).
//
// So na escrita, de proposito. Se a loja desligar o toggle depois de ter 40 OS
// abertas, bloquear o GET tambem esconderia dela os aparelhos que estao no
// balcao — dado que ela ja cadastrou e ainda precisa ver pra devolver. Mesmo
// raciocinio da armadilha #3: gate em criacao, nunca em leitura.
async function assertOsEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'os_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa nao encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') throw erroOsDesligada();
}

function erroOsDesligada() {
  const err = new Error('Ordem de Servico nao esta habilitada. Ative em Configuracoes > PDV.');
  err.status = 403;
  err.code = 'OS_DISABLED';
  return err;
}

// ─── Maquina de status ───────────────────────────────────────
//
// 'pronta' -> 'em_execucao' existe porque retrabalho existe: o tecnico marca
// pronta, o cliente vem buscar, testa no balcao e o defeito continua la. Sem
// essa aresta a loja seria obrigada a cancelar e abrir OS nova, perdendo o
// historico do aparelho — que e justamente o que importa num retrabalho.
const TRANSICOES = {
  aberta:      ['em_execucao', 'cancelada'],
  em_execucao: ['pronta', 'cancelada'],
  pronta:      ['entregue', 'em_execucao', 'cancelada'],
  entregue:    [],
  cancelada:   [],
};

const STATUS_VALIDOS = Object.keys(TRANSICOES);

// ─── Kind e gate por kind ────────────────────────────────────
//
// O gate e escolhido pelo kind da OS, nao pela rota: uma loja que tem so a
// otica ligada (os_enabled=false) precisa mexer nas OS de otica dela, e uma
// que desligou a otica nao pode continuar abrindo oculos por uma rota que
// so olhasse os_enabled.
//
// Na abertura (POST) o kind vem do body e o gate certo e chamado direto.
// Nas rotas que operam numa OS existente, os DOIS toggles sao lidos numa
// query so ANTES de carregar a OS (lerFlagsDoModulo) e a decisao fica pra
// depois, pelo kind carregado (exigirGate). A ordem "gate, depois OS" e a
// mesma de sempre — o que mudou e que a leitura do toggle e a decisao
// deixaram de ser o mesmo passo.
const KINDS = ['reparo', 'otica'];

async function gateParaKind(companyId, kind) {
  if (kind === 'otica') return assertOticaEnabled(companyId);
  return assertOsEnabled(companyId);
}

// Alias `enabled` = os_enabled de proposito: e o nome que assertOsEnabled
// sempre usou, e o que os testes de integracao da OS devolvem.
async function lerFlagsDoModulo(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'os_enabled'    AS enabled,
            pdv_settings->>'otica_enabled' AS otica_enabled
       FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa nao encontrada');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

function exigirGate(flags, kind) {
  if (kind === 'otica') {
    if (flags.otica_enabled !== 'true') throw erroOticaDesligada();
    return;
  }
  if (flags.enabled !== 'true') throw erroOsDesligada();
}

// ─── Maquina do laboratorio (so kind='otica') ────────────────
//
// Separada da maquina de status de proposito (decisao b da 334): status diz
// onde o PEDIDO esta pro cliente; lab_status diz onde a LENTE esta pra loja.
// 'refacao' volta pra 'no_laboratorio' — a lente foi refeita, nao o pedido.
const LAB_TRANSICOES = {
  aguardando_envio: ['no_laboratorio'],
  no_laboratorio:   ['recebida'],
  recebida:         ['em_montagem', 'refacao'],
  em_montagem:      ['refacao'],
  refacao:          ['no_laboratorio'],
};
const LAB_STATUS_VALIDOS = Object.keys(LAB_TRANSICOES);

// Lente que ainda nao voltou do laboratorio nao pode virar oculos pronto.
const LAB_STATUS_PRONTA_OK = ['recebida', 'em_montagem'];

// 'sol' = oculos de sol com grau (QA no app, 15/09/2026: o front ja oferecia
// a opcao e o backend recusava a OS inteira).
const USOS = ['longe', 'perto', 'multifocal', 'bifocal', 'sol'];

// p-205: 'par' (as duas lentes) ou 'unidade' (uma lente so). O que o
// laboratorio faz: so a lente, so a montagem, ou as duas.
const QUANTIDADES = ['par', 'unidade'];
const TIPOS_DE_SERVICO = ['lente', 'montagem', 'lente_montagem'];

// Shape minimo do snapshot `optical`. Nao valida o grau em si (isso e a
// receita, em otica.js): aqui so garante que a OS nasceu com o que a
// montagem precisa — receita com os dois olhos, lente e armacao.
function validarOptical(optical) {
  if (!optical || typeof optical !== 'object' || Array.isArray(optical)) {
    return { erro: 'optical obrigatorio para OS de otica', code: 'RECEITA_OBRIGATORIA' };
  }
  const rx = optical.prescription;
  const olhoOk = (o) => o && typeof o === 'object' && !Array.isArray(o);
  if (!rx || typeof rx !== 'object' || !olhoOk(rx.od) || !olhoOk(rx.oe)) {
    return { erro: 'optical.prescription com od e oe e obrigatorio', code: 'RECEITA_OBRIGATORIA' };
  }
  if (!optical.lens || typeof optical.lens !== 'object' || Array.isArray(optical.lens)) {
    return { erro: 'optical.lens obrigatorio', code: 'LENTE_OBRIGATORIA' };
  }
  if (!optical.frame || typeof optical.frame !== 'object' || Array.isArray(optical.frame)) {
    return { erro: 'optical.frame obrigatorio', code: 'ARMACAO_OBRIGATORIA' };
  }
  if (optical.use != null && !USOS.includes(optical.use)) {
    return { erro: `optical.use deve ser um de: ${USOS.join(', ')}`, code: 'USO_INVALIDO' };
  }
  if (optical.adaptation_warranty_days != null) {
    const n = Number(optical.adaptation_warranty_days);
    if (!Number.isInteger(n) || n < 0) {
      return { erro: 'optical.adaptation_warranty_days deve ser inteiro >= 0' };
    }
  }
  // p-205 (23/11/2026): quantidade e tipo de servico. Opcionais: a OS que
  // nao manda os dois continua exatamente como era (e a folha nao marca nada).
  if (optical.quantity != null && !QUANTIDADES.includes(optical.quantity)) {
    return { erro: `optical.quantity deve ser um de: ${QUANTIDADES.join(', ')}`, code: 'QUANTIDADE_INVALIDA' };
  }
  if (optical.service_type != null && !TIPOS_DE_SERVICO.includes(optical.service_type)) {
    return { erro: `optical.service_type deve ser um de: ${TIPOS_DE_SERVICO.join(', ')}`, code: 'SERVICO_INVALIDO' };
  }
  return null;
}

// Campos que o PATCH aceita. Whitelist: qualquer coisa fora daqui e ignorada
// em silencio, entao um front mandando company_id ou os_number nao reescreve
// identidade nem numeracao.
const CAMPOS_EDITAVEIS = [
  'equipment_type', 'equipment_brand', 'equipment_model', 'equipment_serial',
  'equipment_condition', 'equipment_accessories',
  'reported_issue', 'diagnosis', 'solution',
  'technician_id', 'promised_at', 'warranty_days', 'notes',
  'intake_signature_url',
  // otica (334): trocar de laboratorio, anotar o numero do pedido la e
  // amarrar a venda do sinal depois da abertura.
  'lab_id', 'lab_order_ref', 'deposit_sale_id',
];

// Validacoes de tenant dos campos de otica (lab, venda do sinal, receita).
// Lancam err.status pra cair no falhar() de quem chamou.
async function validarRefsOtica(cid, { lab_id, deposit_sale_id, prescription_id, customer_id }) {
  let lab = null;
  if (lab_id) {
    const r = await db.query(
      'SELECT id, lead_days FROM optical_labs WHERE id = $1 AND company_id = $2',
      [lab_id, cid]
    );
    if (!r.rows.length) {
      const err = new Error('Laboratorio nao encontrado nesta empresa');
      err.status = 404;
      throw err;
    }
    lab = r.rows[0];
  }
  if (deposit_sale_id) {
    const r = await db.query(
      'SELECT id FROM sales WHERE id = $1 AND company_id = $2',
      [deposit_sale_id, cid]
    );
    if (!r.rows.length) {
      const err = new Error('Venda do sinal nao encontrada nesta empresa');
      err.status = 404;
      throw err;
    }
  }
  if (prescription_id) {
    const params = [prescription_id, cid];
    let sql = 'SELECT id FROM optical_prescriptions WHERE id = $1 AND company_id = $2';
    if (customer_id) { params.push(customer_id); sql += ' AND customer_id = $3'; }
    const r = await db.query(sql, params);
    if (!r.rows.length) {
      const err = new Error('Receita nao encontrada para este cliente');
      err.status = 404;
      throw err;
    }
  }
  return { lab };
}

function somaItens(items) {
  return items.reduce((acc, it) => {
    const q = parseFloat(it.quantity);
    const p = parseFloat(it.unit_price);
    return acc + (Number.isFinite(q) ? q : 0) * (Number.isFinite(p) ? p : 0);
  }, 0);
}

function validarItens(items) {
  if (!Array.isArray(items)) return 'items deve ser array';
  for (const [i, it] of items.entries()) {
    if (!it || !String(it.description || '').trim()) {
      return `items[${i}].description obrigatorio`;
    }
    if (it.kind != null && !['servico', 'peca'].includes(it.kind)) {
      return `items[${i}].kind deve ser 'servico' ou 'peca'`;
    }
    if (!(parseFloat(it.quantity) > 0)) {
      return `items[${i}].quantity deve ser > 0`;
    }
    if (!(parseFloat(it.unit_price) >= 0)) {
      return `items[${i}].unit_price deve ser >= 0`;
    }
  }
  return null;
}

// SELECT unico da OS com os nomes que a tela precisa. COALESCE no nome da
// empresa nao entra aqui (nao ha join em companies), mas cliente e tecnico sim.
//
// Duas versoes: com os joins da otica (laboratorio e venda do sinal, 334) e
// a original. O backend sobe antes da migration (armadilha #1): com a 334
// pendente, o join em optical_labs da 42P01 e `so.kind` da 42703 — e a OS
// de reparo, que ja existia, nao pode parar por causa disso.
const SELECT_OS_LEGADO = `
  SELECT so.*,
         c.name  AS customer_name,
         c.phone AS customer_phone,
         e.name  AS technician_name
    FROM service_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN employees e ON e.id = so.technician_id
`;

const SELECT_OS = `
  SELECT so.*,
         c.name  AS customer_name,
         c.phone AS customer_phone,
         e.name  AS technician_name,
         l.name  AS lab_name,
         ds.total_amount AS deposit_sale_total,
         -- O que ja entrou no caixa pela venda do sinal. total_amount e o
         -- valor cheio do par; sem esta soma a tela mostrava o total como se
         -- fosse o sinal (QA no app, 15/09/2026).
         (SELECT COALESCE(SUM(sp.amount), 0) FROM sale_payments sp
           WHERE sp.sale_id = so.deposit_sale_id) AS deposit_paid
    FROM service_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN employees e ON e.id = so.technician_id
    LEFT JOIN optical_labs l ON l.id = so.lab_id
    LEFT JOIN sales ds ON ds.id = so.deposit_sale_id
`;

// Cache module-level do "schema da otica existe?". null = ainda nao sabe;
// false expira em 1 minuto pra que a migration aplicada com o servidor no
// ar passe a valer sem redeploy.
let _schemaOtica = null;
let _schemaOticaAte = 0;
const SCHEMA_RECHECK_MS = 60 * 1000;

// So o codigo nao basta: "relation service_orders does not exist" (313
// pendente) e "relation optical_labs does not exist" (334 pendente) sao os
// dois 42P01, e so o segundo tem fallback — no primeiro nao ha query legada
// que funcione, e quem trata e o 42P01 de cada rota. O nome do objeto vem
// na mensagem do Postgres.
const OBJETOS_334 = /optical_labs|lab_id|lab_status|deposit_sale_id|\bkind\b/i;

function schemaOticaAusente(e) {
  return !!e && (e.code === '42703' || e.code === '42P01') && OBJETOS_334.test(String(e.message || ''));
}

function schemaOticaConhecido() {
  if (_schemaOtica === false && Date.now() > _schemaOticaAte) _schemaOtica = null;
  return _schemaOtica;
}

// Roda a query da OS com os joins novos; se o schema ainda nao tem otica,
// cai pra versao original (o WHERE aqui nunca toca coluna nova — a
// listagem, que filtra por kind, tem o proprio fallback).
async function consultarOs(where, params) {
  if (schemaOticaConhecido() !== false) {
    try {
      const { rows } = await db.query(`${SELECT_OS} WHERE ${where}`, params);
      _schemaOtica = true;
      return rows;
    } catch (e) {
      if (!schemaOticaAusente(e) || _schemaOtica === true) throw e;
      _schemaOtica = false;
      _schemaOticaAte = Date.now() + SCHEMA_RECHECK_MS;
    }
  }
  const { rows } = await db.query(`${SELECT_OS_LEGADO} WHERE ${where}`, params);
  return rows;
}

async function carregarOs(osId, companyId) {
  const rows = await consultarOs('so.id = $1 AND so.company_id = $2', [osId, companyId]);
  return rows[0] || null;
}

// ─── Aviso "oculos prontos" ──────────────────────────────────
//
// Utilidade (source type otica_pronta): e resposta a um pedido que o
// cliente fez, nao promocao. Sem dado de receita em lugar nenhum — nem no
// template, nem no texto do wa.me: o link do tracker tambem nao expoe.
//
// NUNCA lanca por falha de WhatsApp. A fila pode pular (template nao
// aprovado, sem credencial, teto) e nada disso e erro da OS: a resposta
// diz queued:false com o motivo e entrega o wa.me pra loja mandar na mao.
async function nomeDaLoja(cid) {
  const { rows } = await db.query(
    'SELECT COALESCE(trade_name, legal_name) AS nome FROM companies WHERE id = $1',
    [cid]
  );
  return (rows[0] && rows[0].nome) || 'nossa loja';
}

async function avisarOculosProntos(os, cid) {
  const track_url = os.tracker_token
    ? `${urlPublicaDoApp()}/acompanhar/${os.tracker_token}`
    : null;
  const loja = await nomeDaLoja(cid);
  const nome = primeiroNome(os.customer_name);
  const texto = `Olá, ${nome}! Seus óculos ficaram prontos e já podem ser retirados na ${loja}.`
    + (track_url ? ` Acompanhe: ${track_url}` : '');
  const phone = waOutbox.normalizePhone(os.customer_phone);
  const wa_link = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(texto)}` : null;

  let queued = false;
  let skip_reason = null;
  try {
    const r = await waOutbox.enqueue({
      companyId: cid,
      toPhone: os.customer_phone,
      kind: 'template',
      templateName: 'otica_pronta',
      templateLanguage: 'pt_BR',
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: waParam(nome, 'Cliente') },
          { type: 'text', text: waParam(loja, 'Loja') },
          { type: 'text', text: waParam(track_url, '-') },
        ],
      }],
      sourceType: 'otica_pronta',
      sourceId: String(os.id),
      dedupeKey: `otica_pronta:${os.id}`,
    });
    queued = !!(r && r.queued);
    skip_reason = queued ? null : ((r && r.reason) || 'NAO_ENFILEIRADO');
    if (queued) {
      try {
        await db.query(
          'UPDATE service_orders SET ready_notified_at = NOW() WHERE id = $1 AND company_id = $2',
          [os.id, cid]
        );
      } catch (e) {
        if (!schemaOticaAusente(e)) throw e;
      }
    }
  } catch (e) {
    skip_reason = schemaOticaAusente(e) ? 'FILA_INDISPONIVEL' : 'ERRO_FILA';
    console.error('[service-orders:notify-ready] fila falhou:', e.code || '', e.message);
  }
  return { queued, skip_reason, track_url, wa_link };
}

async function carregarItens(osId) {
  const { rows } = await db.query(
    `SELECT id, service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order, created_at
       FROM service_order_items
      WHERE service_order_id = $1
      ORDER BY sort_order, created_at`,
    [osId]
  );
  return rows;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[service-orders:${contexto}]`, err.message);
  return res.status(500).json({ error: 'Erro ao processar ordem de servico' });
}

// ─── GET /service-orders ─────────────────────────────────────
// Sem gate: ver assertOsEnabled().
router.get('/', async function (req, res) {
  const cid = req.params.id;
  const { status, customer_id, q, kind, lab_status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const days  = Math.min(parseInt(req.query.days, 10) || 180, 730);

  if (status && !STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }
  if (kind && !KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind deve ser um de: ${KINDS.join(', ')}` });
  }
  if (lab_status && !LAB_STATUS_VALIDOS.includes(lab_status)) {
    return res.status(400).json({ error: `lab_status deve ser um de: ${LAB_STATUS_VALIDOS.join(', ')}` });
  }

  // O WHERE e montado duas vezes (com e sem as clausulas de kind/lab_status)
  // porque o fallback pro schema sem otica nao pode carregar parametro
  // sobrando — o Postgres recusa bind com mais valores que placeholders.
  function montarWhere(comOtica) {
    const params = [cid];
    let where = 'so.company_id = $1';

    if (status) {
      params.push(status);
      where += ` AND so.status = $${params.length}`;
    }
    if (comOtica && kind) {
      params.push(kind);
      where += ` AND so.kind = $${params.length}`;
    }
    if (comOtica && lab_status) {
      params.push(lab_status);
      where += ` AND so.lab_status = $${params.length}`;
    }
    if (customer_id) {
      params.push(customer_id);
      where += ` AND so.customer_id = $${params.length}`;
    }
    if (q && String(q).trim()) {
      // Busca do balcao: numero da OS, nome do cliente, ou marca/modelo/serie do
      // aparelho — que e como o cliente se identifica quando esqueceu o papel.
      //
      // Dois parametros de proposito: o ILIKE precisa dos %, e a comparacao por
      // numero precisa do termo CRU. Reusar o parametro com % faria
      // CAST(os_number AS TEXT) = '%12%', que nunca casa com nada — a busca por
      // numero simplesmente nao existiria, e em silencio.
      const termo = String(q).trim();
      params.push(`%${termo}%`);
      const pLike = `$${params.length}`;
      params.push(termo);
      const pRaw = `$${params.length}`;
      where += ` AND (c.name ILIKE ${pLike}
                   OR so.equipment_brand ILIKE ${pLike}
                   OR so.equipment_model ILIKE ${pLike}
                   OR so.equipment_serial ILIKE ${pLike}
                   OR CAST(so.os_number AS TEXT) = ${pRaw})`;
    }

    params.push(String(days));
    where += ` AND so.created_at >= NOW() - ($${params.length} || ' days')::interval`;
    params.push(limit);
    return { where, params, sufixo: `ORDER BY so.created_at DESC LIMIT $${params.length}` };
  }

  try {
    const novo = montarWhere(true);
    if (schemaOticaConhecido() !== false) {
      try {
        const { rows } = await db.query(`${SELECT_OS} WHERE ${novo.where} ${novo.sufixo}`, novo.params);
        _schemaOtica = true;
        return res.json({ orders: rows });
      } catch (e) {
        if (!schemaOticaAusente(e) || _schemaOtica === true) throw e;
        _schemaOtica = false;
        _schemaOticaAte = Date.now() + SCHEMA_RECHECK_MS;
      }
    }
    // Sem a 334 toda OS e de reparo: filtro por otica/laboratorio nao acha nada.
    if (kind === 'otica' || lab_status) return res.json({ orders: [] });
    const legado = montarWhere(false);
    const { rows } = await db.query(`${SELECT_OS_LEGADO} WHERE ${legado.where} ${legado.sufixo}`, legado.params);
    res.json({ orders: rows });
  } catch (err) {
    // 42P01: migration 313 ainda nao aplicada neste ambiente. Lista vazia e
    // melhor que 500 — a tela abre e diz "nenhuma OS", que e a verdade.
    if (err.code === '42P01') return res.json({ orders: [] });
    falhar(res, err, 'GET');
  }
});

// ─── POST /service-orders ────────────────────────────────────
// Abre a OS na entrada do equipamento. Nasce em 'aberta', sem venda.
router.post('/', async function (req, res) {
  const cid = req.params.id;
  const {
    customer_id, items = [],
    equipment_type, equipment_brand, equipment_model, equipment_serial,
    equipment_condition, equipment_accessories, equipment_photos,
    technician_id, warranty_days, notes,
    intake_signature_url,
    optical, lab_id, lab_order_ref, deposit_sale_id,
  } = req.body || {};
  let { reported_issue, promised_at } = req.body || {};
  const kind = (req.body && req.body.kind) || 'reparo';

  if (!KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind deve ser um de: ${KINDS.join(', ')}` });
  }
  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id obrigatorio: sem cliente nao ha pra quem devolver o aparelho' });
  }

  if (kind === 'otica') {
    const erroOptical = validarOptical(optical);
    if (erroOptical) return res.status(400).json({ error: erroOptical.erro, code: erroOptical.code });
    // Na otica o "defeito relatado" e o que esta sendo feito. Se o balcao
    // nao escreveu nada, o documento sai com o uso do oculos em vez de uma
    // linha vazia.
    if (!String(reported_issue || '').trim()) {
      reported_issue = optical.use ? `Óculos de grau — ${optical.use}` : 'Óculos de grau';
    }
  } else if (!String(reported_issue || '').trim()) {
    return res.status(400).json({ error: 'reported_issue obrigatorio' });
  }
  const erroItens = validarItens(items);
  if (erroItens) return res.status(400).json({ error: erroItens });

  const wDays = warranty_days == null ? 0 : parseInt(warranty_days, 10);
  if (!Number.isFinite(wDays) || wDays < 0) {
    return res.status(400).json({ error: 'warranty_days deve ser inteiro >= 0' });
  }

  let client;
  try {
    await gateParaKind(cid, kind);

    // Cliente tem que ser DO DONO desta empresa — sem isso, um customer_id
    // de outro dono passaria pela FK (que so olha customers.id) e a OS
    // nasceria apontando pra fora do tenant.
    //
    // 24/11/2026: era "desta empresa". Mas a lista de clientes do app e do
    // DONO (owner-scope, customers.js): numa conta com duas lojas o cliente
    // cadastrado na outra aparecia na lista e a OS dava 404 "Cliente nao
    // encontrado nesta empresa", em reparo e em otica. Mesma regra da receita
    // (Aura-backend#1100). A OS continua nascendo nesta loja (company_id);
    // so a checagem do cliente olha as lojas do mesmo dono.
    const lojasDoDono = await getOwnerScopedCompanyIds(cid);
    const cust = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = ANY($2)',
      [customer_id, lojasDoDono]
    );
    if (!cust.rows.length) {
      return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa' });
    }
    if (technician_id) {
      const tec = await db.query(
        'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
        [technician_id, cid]
      );
      if (!tec.rows.length) {
        return res.status(404).json({ error: 'Tecnico nao encontrado nesta empresa' });
      }
    }

    // Snapshot final da otica: garantia de adaptacao default vem da
    // configuracao da loja; prazo default vem do lead_days do laboratorio.
    let opticalFinal = null;
    if (kind === 'otica') {
      const { lab } = await validarRefsOtica(cid, {
        lab_id, deposit_sale_id, prescription_id: optical.prescription_id, customer_id,
      });
      const settings = await carregarOticaSettings(cid);
      const garantiaPadrao = Number(settings && settings.adaptation_warranty_days);
      opticalFinal = {
        ...optical,
        prescription_id: optical.prescription_id || null,
        adaptation_warranty_days: optical.adaptation_warranty_days != null
          ? Number(optical.adaptation_warranty_days)
          : (Number.isFinite(garantiaPadrao) ? garantiaPadrao : OTICA_DEFAULTS.adaptation_warranty_days),
      };
      if (!promised_at && lab && lab.lead_days != null) {
        // Dias corridos em ms, nao setDate(): o Brasil nao tem horario de
        // verao desde 2019 e setDate() opera no fuso do processo.
        promised_at = new Date(Date.now() + Number(lab.lead_days) * 86400000);
      }
    }

    client = await db.connect();
    await client.query('BEGIN');

    const total = somaItens(items);
    const paramsBase = [
      cid, customer_id, String(reported_issue).trim(),
      equipment_type || null, equipment_brand || null,
      equipment_model || null, equipment_serial || null,
      equipment_condition || null, equipment_accessories || null,
      JSON.stringify(Array.isArray(equipment_photos) ? equipment_photos : []),
      technician_id || null,
      promised_at || null,
      wDays,
      notes || null,
      intake_signature_url || null,
      intake_signature_url ? new Date() : null,
      total.toFixed(2),
      req.user?.id || null,
    ];
    // Duas queries de INSERT de proposito: a do reparo e a ORIGINAL, sem
    // nenhuma coluna da 334, pra continuar funcionando com a migration
    // pendente. So a otica depende do schema novo — e ela nao existe
    // sem ele.
    const { rows } = kind === 'otica'
      ? await client.query(
        `INSERT INTO service_orders
           (company_id, customer_id, status, reported_issue,
            equipment_type, equipment_brand, equipment_model, equipment_serial,
            equipment_condition, equipment_accessories, equipment_photos,
            technician_id, promised_at, warranty_days, notes,
            intake_signature_url, intake_signed_at,
            estimated_amount, created_by,
            kind, optical, lab_id, lab_order_ref, lab_status, deposit_sale_id)
         VALUES ($1,$2,'aberta',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 'otica',$19::jsonb,$20,$21,'aguardando_envio',$22)
         RETURNING *`,
        [
          ...paramsBase,
          JSON.stringify(opticalFinal),
          lab_id || null,
          lab_order_ref ? String(lab_order_ref).trim() : null,
          deposit_sale_id || null,
        ]
      )
      : await client.query(
        `INSERT INTO service_orders
           (company_id, customer_id, status, reported_issue,
            equipment_type, equipment_brand, equipment_model, equipment_serial,
            equipment_condition, equipment_accessories, equipment_photos,
            technician_id, promised_at, warranty_days, notes,
            intake_signature_url, intake_signed_at,
            estimated_amount, created_by)
         VALUES ($1,$2,'aberta',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        paramsBase
      );
    const os = rows[0];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity);
      const price = parseFloat(it.unit_price);
      await client.query(
        `INSERT INTO service_order_items
           (service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          os.id, it.kind || 'servico', String(it.description).trim(),
          it.product_id || null, qty, price, (qty * price).toFixed(2),
          it.sort_order != null ? parseInt(it.sort_order, 10) : i,
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    falhar(res, err, 'POST');
  } finally {
    if (client) client.release();
  }
});

// ─── GET /service-orders/otica-no-caixa?customer_id= ─────────
// p-208 (23/11/2026): a faixa "Óculos deste cliente" do Caixa. OS de otica
// do cliente que pedem uma acao no balcao: pronta para retirada OU com saldo
// em aberto na venda do sinal. Sem gate (leitura, ver assertOsEnabled).
//
// Fica antes de GET /:osId de proposito: senao o Express leria
// "otica-no-caixa" como um osId.
//
// O que NAO vai aqui: a receita (grau) e o CPF. A faixa do Caixa nao precisa
// deles, e a regra da otica e que dado de saude so sai na tela da OS e no
// papel. Lente e armacao vao, para o balconista reconhecer o oculos.
//
// Multi-CNPJ: e por empresa (so.company_id), como toda OS. A OS aberta na
// outra loja do grupo aparece no Caixa DAQUELA loja: e la que esta a venda
// do sinal e o saldo dela.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/otica-no-caixa', async function (req, res) {
  const cid = req.params.id;
  const customerId = String(req.query.customer_id || '');
  if (!UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id obrigatorio' });
  }
  try {
    const { rows } = await db.query(
      `SELECT so.id, so.os_number, so.status, so.lab_status, so.promised_at,
              so.estimated_amount, so.deposit_sale_id, so.sale_id, so.created_at,
              so.optical->'lens'  AS lens,
              so.optical->'frame' AS frame,
              so.optical->>'use'  AS use,
              so.optical->>'quantity'     AS quantity,
              so.optical->>'service_type' AS service_type,
              ds.status       AS deposit_sale_status,
              ds.total_amount AS deposit_sale_total,
              COALESCE(bal.open_amount, 0) AS open_amount,
              COALESCE(bal.open_count, 0)  AS open_installments,
              COALESCE(bal.total_count, 0) AS total_installments,
              bal.next_due_date
         FROM service_orders so
         LEFT JOIN sales ds ON ds.id = so.deposit_sale_id
         LEFT JOIN LATERAL (
           SELECT ROUND(SUM(CASE WHEN ci.status NOT IN ('paid', 'cancelled')
                                 THEN GREATEST(ci.amount_due - COALESCE(ci.covered_amount, 0), 0)
                                 ELSE 0 END)::numeric, 2) AS open_amount,
                  COUNT(*) FILTER (WHERE ci.status NOT IN ('paid', 'cancelled')
                                     AND ci.amount_due - COALESCE(ci.covered_amount, 0) > 0.005) AS open_count,
                  COUNT(*) FILTER (WHERE ci.status <> 'cancelled') AS total_count,
                  MIN(ci.due_date) FILTER (WHERE ci.status NOT IN ('paid', 'cancelled')
                                             AND ci.amount_due - COALESCE(ci.covered_amount, 0) > 0.005) AS next_due_date
             FROM credit_installments ci
            WHERE ci.company_id = so.company_id AND ci.sale_id = so.deposit_sale_id
         ) bal ON so.deposit_sale_id IS NOT NULL
        WHERE so.company_id = $1 AND so.customer_id = $2
          AND so.kind = 'otica' AND so.status <> 'cancelada'
          AND (so.status = 'pronta' OR COALESCE(bal.open_amount, 0) > 0.005)
        ORDER BY so.created_at DESC
        LIMIT 10`,
      [cid, customerId]
    );
    res.json({
      orders: rows.map((r) => ({
        ...r,
        open_amount: Number(r.open_amount) || 0,
        open_installments: Number(r.open_installments) || 0,
        total_installments: Number(r.total_installments) || 0,
        // Sem sinal nao ha venda: o Caixa cobra como venda nova e entrega
        // vinculando (POST /:osId/status com sale_id). Com sinal, o saldo e
        // recebido em POST /:osId/receber-saldo, sem venda nova.
        sem_venda: !r.deposit_sale_id && !r.sale_id,
      })),
    });
  } catch (err) {
    // 313/334 pendentes, ou credit_installments ausente: a faixa nao aparece.
    if (err.code === '42P01' || err.code === '42703') return res.json({ orders: [] });
    falhar(res, err, 'GET:otica-no-caixa');
  }
});

// ─── GET /service-orders/:osId ───────────────────────────────
router.get('/:osId', async function (req, res) {
  try {
    const os = await carregarOs(req.params.osId, req.params.id);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    res.json({ order: os, items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'GET:id');
  }
});

// ─── PATCH /service-orders/:osId ─────────────────────────────
router.patch('/:osId', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};

  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    exigirGate(flags, os.kind);

    if (os.status === 'entregue' || os.status === 'cancelada') {
      return res.status(409).json({
        error: `OS ${os.status} nao pode mais ser editada`,
        code: 'OS_FECHADA',
      });
    }

    if (body.technician_id) {
      const tec = await db.query(
        'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
        [body.technician_id, cid]
      );
      if (!tec.rows.length) {
        return res.status(404).json({ error: 'Tecnico nao encontrado nesta empresa' });
      }
    }
    if (body.warranty_days != null) {
      const w = parseInt(body.warranty_days, 10);
      if (!Number.isFinite(w) || w < 0) {
        return res.status(400).json({ error: 'warranty_days deve ser inteiro >= 0' });
      }
    }
    if ('reported_issue' in body && !String(body.reported_issue || '').trim()) {
      return res.status(400).json({ error: 'reported_issue nao pode ficar vazio' });
    }
    if ('optical' in body) {
      if (os.kind !== 'otica') {
        return res.status(400).json({ error: 'optical so existe em OS de otica', code: 'OS_NAO_E_OTICA' });
      }
      const erroOptical = validarOptical(body.optical);
      if (erroOptical) return res.status(400).json({ error: erroOptical.erro, code: erroOptical.code });
    }
    if ((body.lab_id || body.deposit_sale_id) && os.kind !== 'otica') {
      return res.status(400).json({ error: 'lab_id e deposit_sale_id so existem em OS de otica', code: 'OS_NAO_E_OTICA' });
    }
    // p-208: trocar a venda do sinal de uma OS que ja tem venda abriria a
    // porta para a segunda cobranca (o saldo e parcela da venda que ja esta la).
    if (body.deposit_sale_id) {
      const jaTem = os.deposit_sale_id || os.sale_id;
      if (jaTem && String(jaTem) !== String(body.deposit_sale_id)) {
        return res.status(409).json({
          error: 'Esta OS de óculos já tem venda. A venda do sinal não pode ser trocada.',
          code: 'OS_JA_TEM_VENDA',
        });
      }
    }
    await validarRefsOtica(cid, {
      lab_id: body.lab_id, deposit_sale_id: body.deposit_sale_id,
      prescription_id: body.optical && body.optical.prescription_id, customer_id: os.customer_id,
    });

    const sets = [];
    const params = [];
    for (const campo of CAMPOS_EDITAVEIS) {
      if (!(campo in body)) continue;
      params.push(body[campo] === '' ? null : body[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
    if (Array.isArray(body.equipment_photos)) {
      params.push(JSON.stringify(body.equipment_photos));
      sets.push(`equipment_photos = $${params.length}::jsonb`);
    }
    // `optical` substitui o jsonb INTEIRO (nao faz merge): o front edita o
    // snapshot como um todo e um merge parcial deixaria lente antiga
    // misturada com armacao nova.
    if ('optical' in body) {
      params.push(JSON.stringify({ ...body.optical, prescription_id: body.optical.prescription_id || null }));
      sets.push(`optical = $${params.length}::jsonb`);
    }
    // Assinatura de entrada carimba a hora sozinha — quem assina e o cliente
    // no balcao, nao o front escolhendo o timestamp.
    if (body.intake_signature_url && !os.intake_signed_at) {
      sets.push('intake_signed_at = NOW()');
    }
    if (!sets.length) return res.json({ order: os, items: await carregarItens(os.id) });

    params.push(req.params.osId, cid);
    const { rows } = await db.query(
      `UPDATE service_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
        RETURNING id`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });

    res.json({ order: await carregarOs(req.params.osId, cid), items: await carregarItens(req.params.osId) });
  } catch (err) {
    falhar(res, err, 'PATCH');
  }
});

// ─── PUT /service-orders/:osId/items ─────────────────────────
// Substitui a lista inteira e recalcula estimated_amount.
router.put('/:osId/items', async function (req, res) {
  const cid = req.params.id;
  const { items } = req.body || {};

  const erroItens = validarItens(items);
  if (erroItens) return res.status(400).json({ error: erroItens });

  let client;
  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    exigirGate(flags, os.kind);

    if (os.status === 'entregue' || os.status === 'cancelada') {
      return res.status(409).json({ error: `OS ${os.status} nao pode mais ser editada`, code: 'OS_FECHADA' });
    }
    // Orcamento aprovado e um acordo, nao um rascunho. Mexer no valor depois
    // que o cliente aprovou tem que passar por nova aprovacao — senao a loja
    // troca o preco por baixo de um "sim" que ja foi dado.
    if (os.approved_at) {
      return res.status(409).json({
        error: 'Orcamento ja aprovado pelo cliente. Reabra a aprovacao antes de alterar os itens.',
        code: 'ORCAMENTO_APROVADO',
      });
    }

    client = await db.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM service_order_items WHERE service_order_id = $1', [os.id]);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qty = parseFloat(it.quantity);
      const price = parseFloat(it.unit_price);
      await client.query(
        `INSERT INTO service_order_items
           (service_order_id, kind, description, product_id,
            quantity, unit_price, total_price, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          os.id, it.kind || 'servico', String(it.description).trim(),
          it.product_id || null, qty, price, (qty * price).toFixed(2),
          it.sort_order != null ? parseInt(it.sort_order, 10) : i,
        ]
      );
    }

    await client.query(
      'UPDATE service_orders SET estimated_amount = $1 WHERE id = $2',
      [somaItens(items).toFixed(2), os.id]
    );
    await client.query('COMMIT');

    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    falhar(res, err, 'PUT:items');
  } finally {
    if (client) client.release();
  }
});

// ─── POST /service-orders/:osId/approve ──────────────────────
// Cliente aprovou o orcamento. Idempotente: reaprovar nao move a data.
router.post('/:osId/approve', async function (req, res) {
  const cid = req.params.id;
  const { note } = req.body || {};

  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    exigirGate(flags, os.kind);

    if (os.status === 'cancelada') {
      return res.status(409).json({ error: 'OS cancelada nao pode ser aprovada', code: 'OS_FECHADA' });
    }
    if (os.approved_at) {
      return res.json({ order: os, items: await carregarItens(os.id) });
    }

    await db.query(
      `UPDATE service_orders SET approved_at = NOW(), approved_note = $1
        WHERE id = $2 AND company_id = $3`,
      [note || null, os.id, cid]
    );
    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'POST:approve');
  }
});

// ─── POST /service-orders/:osId/status ───────────────────────
// Transicao validada. `entregue` e o unico ponto em que a OS toca numa venda.
router.post('/:osId/status', async function (req, res) {
  const cid = req.params.id;
  const { status, sale_id, pickup_signature_url, cancel_reason, solution } = req.body || {};

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    exigirGate(flags, os.kind);

    if (status === os.status) {
      return res.json({ order: os, items: await carregarItens(os.id) });
    }
    if (!TRANSICOES[os.status].includes(status)) {
      return res.status(409).json({
        error: `Transicao invalida: ${os.status} -> ${status}`,
        code: 'TRANSICAO_INVALIDA',
        permitidas: TRANSICOES[os.status],
      });
    }
    // Otica: 'pronta' e "pode vir buscar", e sem a lente de volta do
    // laboratorio nao ha o que buscar. A maquina de status nao sabe disso
    // (e nem deve — e regra do laboratorio, nao do pedido).
    if (status === 'pronta' && os.kind === 'otica' && !LAB_STATUS_PRONTA_OK.includes(os.lab_status)) {
      return res.status(409).json({
        error: 'Lentes ainda nao recebidas do laboratorio. Registre o recebimento antes de marcar pronta.',
        code: 'LENTES_NAO_RECEBIDAS',
        lab_status: os.lab_status || null,
      });
    }

    const sets = ['status = $1'];
    const params = [status];

    if (status === 'entregue') {
      // sale_id e OPCIONAL: existe entrega sem venda (garantia, retrabalho,
      // cortesia). Ver decisao (b) da migration 313 — por isso status e campo
      // proprio e nao "tem venda => entregue".
      if (sale_id) {
        const venda = await db.query(
          'SELECT id, customer_id FROM sales WHERE id = $1 AND company_id = $2',
          [sale_id, cid]
        );
        if (!venda.rows.length) {
          return res.status(404).json({ error: 'Venda nao encontrada nesta empresa' });
        }
        // p-208 (23/11/2026): a OS de otica tem UMA venda. A que tem sinal ja
        // tem a dela (deposit_sale_id) e o saldo e parcela do crediario dessa
        // venda: amarrar outra venda aqui seria cobrar o cliente duas vezes.
        // O saldo se recebe em POST /:osId/receber-saldo. A sem sinal aceita
        // a venda do Caixa, desde que seja do mesmo cliente.
        if (os.kind === 'otica') {
          const jaTem = os.deposit_sale_id || os.sale_id;
          if (jaTem && String(jaTem) !== String(sale_id)) {
            return res.status(409).json({
              error: 'Esta OS de óculos já tem venda. Receba o saldo pela OS, sem uma venda nova.',
              code: 'OS_JA_TEM_VENDA',
            });
          }
          if (String(venda.rows[0].customer_id || '') !== String(os.customer_id)) {
            return res.status(409).json({
              error: 'A venda é de outro cliente. Escolha o cliente da OS na venda.',
              code: 'VENDA_DE_OUTRO_CLIENTE',
            });
          }
        }
        params.push(sale_id);
        sets.push(`sale_id = $${params.length}`);
      }
      sets.push('delivered_at = NOW()');
      if (pickup_signature_url) {
        params.push(pickup_signature_url);
        sets.push(`pickup_signature_url = $${params.length}`, 'pickup_signed_at = NOW()');
      }
    }

    if (status === 'cancelada') {
      params.push(cancel_reason || null);
      sets.push(`cancel_reason = $${params.length}`, 'cancelled_at = NOW()');
    }

    // Retrabalho: voltar pra execucao limpa a entrega anterior, senao a OS
    // ficaria "em execucao" carimbada como entregue em algum momento do
    // passado, e o relatorio de prazo mentiria.
    if (status === 'em_execucao' && os.status === 'pronta') {
      sets.push('delivered_at = NULL');
    }

    if (solution != null) {
      params.push(String(solution));
      sets.push(`solution = $${params.length}`);
    }

    params.push(os.id, cid);
    await db.query(
      `UPDATE service_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
      params
    );

    const atualizada = await carregarOs(os.id, cid);

    // NFS-e automatica (migration 438): a OS concluida emite a nota dos
    // servicos. So agenda, depois do UPDATE; nunca segura nem derruba o balcao.
    if (status === nfseAutomatica.STATUS_OS_QUE_EMITE && atualizada) {
      nfseAutomatica.aoConcluirOs({ companyId: cid, osId: os.id });
    }

    // Aviso automatico de "oculos prontos" (otica_settings.wa_ready_auto).
    // Best-effort: a transicao ja esta gravada e um problema na fila do
    // WhatsApp nao pode desfaze-la nem virar 500 pro balcao.
    if (status === 'pronta' && os.kind === 'otica' && atualizada) {
      try {
        const settings = await carregarOticaSettings(cid);
        if (settings && settings.wa_ready_auto === true) {
          await avisarOculosProntos(atualizada, cid);
        }
      } catch (e) {
        console.error('[service-orders:status] aviso automatico falhou:', e.message);
      }
    }

    res.json({ order: atualizada, items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'POST:status');
  }
});

// ─── POST /service-orders/:osId/lab ──────────────────────────
// Etapa da lente no laboratorio (so kind='otica'). Transicoes em
// LAB_TRANSICOES. Refacao e a unica que exige motivo: e a que custa
// dinheiro e prazo, e "por que refez" e a pergunta que o dono faz depois.
router.post('/:osId/lab', async function (req, res) {
  const cid = req.params.id;
  const { lab_status, lab_order_ref, note } = req.body || {};

  if (!LAB_STATUS_VALIDOS.includes(lab_status)) {
    return res.status(400).json({ error: `lab_status deve ser um de: ${LAB_STATUS_VALIDOS.join(', ')}` });
  }

  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.kind !== 'otica') {
      return res.status(400).json({ error: 'Etapa de laboratorio so existe em OS de otica', code: 'OS_NAO_E_OTICA' });
    }
    exigirGate(flags, 'otica');

    if (['pronta', 'entregue', 'cancelada'].includes(os.status)) {
      return res.status(409).json({
        error: `OS ${os.status} nao aceita mais movimentacao de laboratorio`,
        code: 'OS_FECHADA',
      });
    }

    const atual = os.lab_status || 'aguardando_envio';
    const permitidas = LAB_TRANSICOES[atual] || [];
    if (!permitidas.includes(lab_status)) {
      return res.status(409).json({
        error: `Transicao de laboratorio invalida: ${atual} -> ${lab_status}`,
        code: 'TRANSICAO_LAB_INVALIDA',
        permitidas,
      });
    }
    if (lab_status === 'refacao' && !String(note || '').trim()) {
      return res.status(400).json({ error: 'note obrigatorio na refacao: registre o motivo', code: 'MOTIVO_OBRIGATORIO' });
    }

    const sets = ['lab_status = $1'];
    const params = [lab_status];

    if (lab_status === 'no_laboratorio') {
      sets.push('lab_sent_at = NOW()');
      // Voltando da refacao a lente sai de novo: o recebimento anterior nao
      // vale mais.
      if (atual === 'refacao') sets.push('lab_received_at = NULL');
      // A lente saiu: o pedido esta em execucao, do ponto de vista do cliente.
      if (os.status === 'aberta') sets.push(`status = 'em_execucao'`);
    }
    if (lab_status === 'recebida') {
      sets.push('lab_received_at = NOW()');
    }
    if (lab_status === 'refacao') {
      const n = (Number(os.lab_redo_count) || 0) + 1;
      const dd = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      const carimbo = `[Refação #${n} ${dd}] ${String(note).trim()}`;
      sets.push('lab_redo_count = COALESCE(lab_redo_count, 0) + 1');
      params.push(carimbo);
      sets.push(`notes = CASE WHEN COALESCE(notes, '') = '' THEN $${params.length} ELSE notes || E'\\n' || $${params.length} END`);
    }
    if (lab_order_ref != null) {
      params.push(String(lab_order_ref).trim() || null);
      sets.push(`lab_order_ref = $${params.length}`);
    }

    params.push(os.id, cid);
    await db.query(
      `UPDATE service_orders SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
      params
    );

    res.json({ order: await carregarOs(os.id, cid), items: await carregarItens(os.id) });
  } catch (err) {
    falhar(res, err, 'POST:lab');
  }
});

// ─── POST /service-orders/:osId/receber-saldo ────────────────
// p-208 (23/11/2026): "Receber saldo e entregar" no Caixa, numa operacao so.
//
// A REGRA QUE NAO QUEBRA: o saldo da OS de otica ja e parcela do crediario
// da venda do sinal (deposit_sale_id). Receber aqui QUITA essas parcelas e
// NUNCA cria segunda venda. Por baixo e o mesmo applyPayment do Studio
// (/studio/orders/:oid/registrar-pagamento): liquida o A Receber, cobre a
// parcela, lanca sale_payments na venda do sinal e entra no caixa aberto.
// `saleId` prende o pagamento a ESTA venda: sem ele o FIFO e por cliente e
// quitaria o oculos (ou o fiado) mais antigo dele.
//
// Body: { method: dinheiro|pix|cartao|debito, entregar?: bool (padrao true),
//         amount?: number (padrao: o saldo inteiro), pickup_signature_url? }
// Header Idempotency-Key (opcional, recomendado): a mesma chave na mesma OS
// devolve o que ja foi gravado, sem receber de novo. Sem a chave, o FOR UPDATE
// na OS e nas parcelas faz o segundo clique ver o saldo zerado: recebe 0.
//
// entregar=true exige a OS pronta (ou ja entregue: so recebe). A entrega e a
// mesma do POST /:osId/status 'entregue' (delivered_at, assinatura, NFS-e
// automatica), sem sale_id: a venda da OS continua sendo a do sinal.
//
// Fora daqui: OS SEM sinal. Ela nao tem venda; o Caixa cobra como venda nova
// e entrega vinculando (POST /:osId/status com sale_id). Encargos de atraso
// (mora/multa) tambem nao sao cobrados aqui, como no Studio: o valor cobrado
// e o saldo das parcelas.
const METODOS_DO_SALDO = ['dinheiro', 'pix', 'cartao', 'debito'];
const CHAVE_RE = /^[A-Za-z0-9_:.-]{8,120}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

router.post('/:osId/receber-saldo', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const method = String(body.method || '').toLowerCase();
  const entregar = body.entregar !== false;
  const chave = String(req.get('Idempotency-Key') || '').trim();

  if (!METODOS_DO_SALDO.includes(method)) {
    return res.status(400).json({
      error: `Forma de pagamento invalida. Use: ${METODOS_DO_SALDO.join(', ')}.`,
      code: 'METHOD_INVALIDO',
    });
  }
  if (chave && !CHAVE_RE.test(chave)) {
    return res.status(400).json({ error: 'Idempotency-Key invalida', code: 'CHAVE_INVALIDA' });
  }
  let pedido = null;
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    pedido = r2(body.amount);
    if (!(pedido > 0)) {
      return res.status(400).json({ error: 'O valor recebido deve ser maior que zero.', code: 'AMOUNT_INVALIDO' });
    }
  }
  if (!UUID_RE.test(String(req.params.osId || ''))) {
    return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
  }

  let client;
  try {
    const flags = await lerFlagsDoModulo(cid);
    client = await db.connect();
    await client.query('BEGIN');

    // FOR UPDATE na OS: duas abas (ou dois cliques) no mesmo oculos esperam
    // uma a outra, e a segunda ja le o saldo que a primeira quitou.
    const { rows: osRows } = await client.query(
      `SELECT id, kind, status, customer_id, deposit_sale_id, sale_id
         FROM service_orders WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [req.params.osId, cid]
    );
    const os = osRows[0];
    if (!os) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    }
    if (os.kind !== 'otica') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Receber saldo so existe em OS de otica', code: 'OS_NAO_E_OTICA' });
    }
    exigirGate(flags, 'otica');

    // Repeticao da mesma chave: o pagamento ja esta no razao. Nada e gravado.
    const ledgerKey = chave ? `otica-saldo:${os.id}:${chave}` : null;
    if (ledgerKey) {
      const { rows: ja } = await client.query(
        `SELECT id, amount, payment_method FROM customer_credit_transactions
          WHERE idempotency_key = $1 AND company_id = $2`,
        [ledgerKey, cid]
      );
      if (ja.length) {
        await client.query('COMMIT');
        const restante = await saldoDaVenda(db, cid, os.deposit_sale_id);
        const atual = await carregarOs(os.id, cid);
        return res.json({
          replayed: true,
          order: atual,
          items: await carregarItens(os.id),
          paid: r2(ja[0].amount),
          method: ja[0].payment_method,
          remaining: restante,
          settled: restante <= 0.005,
          delivered: !!atual && atual.status === 'entregue',
          transaction_id: ja[0].id,
          receipt_url: `/companies/${cid}/print/credit/receipts/${ja[0].id}`,
        });
      }
    }

    if (os.status === 'cancelada') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'OS cancelada', code: 'OS_FECHADA' });
    }
    if (!os.deposit_sale_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Esta OS foi aberta sem sinal: não há saldo no crediário. Cobre no Caixa como venda e entregue vinculando a venda.',
        code: 'OS_SEM_SINAL',
      });
    }
    if (entregar && !['pronta', 'entregue'].includes(os.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Os óculos ainda não estão prontos. Dá para receber o saldo sem entregar.',
        code: 'OS_NAO_PRONTA',
        status: os.status,
      });
    }

    const { rows: vendaRows } = await client.query(
      'SELECT id, status, customer_id FROM sales WHERE id = $1 AND company_id = $2',
      [os.deposit_sale_id, cid]
    );
    const venda = vendaRows[0];
    if (!venda || venda.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A venda do sinal desta OS foi cancelada. Confira a venda antes de entregar.',
        code: 'VENDA_DO_SINAL_CANCELADA',
      });
    }

    // Parcelas em aberto DA VENDA DO SINAL, travadas ate o COMMIT.
    const { rows: abertas } = await client.query(
      `SELECT ci.id, ci.customer_id,
              ROUND((ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2) AS open_amount
         FROM credit_installments ci
        WHERE ci.company_id = $1 AND ci.sale_id = $2
          AND ci.status NOT IN ('paid', 'cancelled')
          AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
        ORDER BY ci.due_date ASC
        FOR UPDATE`,
      [cid, os.deposit_sale_id]
    );
    const aberto = r2(abertas.reduce((s, a) => s + Number(a.open_amount || 0), 0));
    const pagar = pedido == null ? aberto : pedido;
    if (pagar > aberto + 0.005) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `O valor (R$ ${pagar.toFixed(2)}) é maior que o saldo em aberto (R$ ${aberto.toFixed(2)}).`,
        code: 'AMOUNT_ACIMA_DO_SALDO',
        open_amount: aberto,
      });
    }

    let result = null;
    if (pagar > 0.005) {
      let sessaoId = null;
      try {
        const s = await client.query(
          `SELECT id FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
          [cid]
        );
        sessaoId = (s.rows[0] && s.rows[0].id) || null;
      } catch (_) { /* sem caixa: o pagamento entra sem sessao, como no Studio */ }

      result = await creditLedger.applyPayment(client, {
        companyId: cid,
        // O cliente DA VENDA (e das parcelas): o razao e por cliente, e o
        // A Receber da venda do sinal e casado por s.customer_id.
        customerId: (abertas[0] && abertas[0].customer_id) || venda.customer_id,
        amount: pagar,
        method,
        sessaoId,
        createdBy: (req.user && req.user.id) || null,
        idempotencyKey: ledgerKey,
        saleId: os.deposit_sale_id,
      });
    }

    let entregou = false;
    if (entregar && os.status === 'pronta') {
      const sets = [`status = 'entregue'`, 'delivered_at = NOW()'];
      const params = [os.id, cid];
      if (body.pickup_signature_url) {
        params.push(String(body.pickup_signature_url));
        sets.push(`pickup_signature_url = $${params.length}`, 'pickup_signed_at = NOW()');
      }
      await client.query(
        `UPDATE service_orders SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2`,
        params
      );
      entregou = true;
    }

    const restante = await saldoDaVenda(client, cid, os.deposit_sale_id);
    await client.query('COMMIT');

    // Depois do COMMIT, sem esperar, como nas rotas de origem.
    if (result) nfseAutomatica.aoReceberPagamento({ companyId: cid, result, saleId: os.deposit_sale_id });
    if (entregou) nfseAutomatica.aoConcluirOs({ companyId: cid, osId: os.id });

    const tx = result && result.transaction;
    res.json({
      replayed: false,
      order: await carregarOs(os.id, cid),
      items: await carregarItens(os.id),
      paid: result ? pagar : 0,
      method,
      remaining: restante,
      settled: restante <= 0.005,
      delivered: entregou,
      transaction_id: tx ? tx.id : null,
      receipt_url: tx ? `/companies/${cid}/print/credit/receipts/${tx.id}` : null,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    falhar(res, err, 'POST:receber-saldo');
  } finally {
    if (client) client.release();
  }
});

// Saldo em aberto das parcelas de uma venda (o que a OS ainda deve).
async function saldoDaVenda(q, cid, saleId) {
  if (!saleId) return 0;
  const { rows } = await q.query(
    `SELECT COALESCE(ROUND(SUM(ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2), 0) AS restante
       FROM credit_installments ci
      WHERE ci.company_id = $1 AND ci.sale_id = $2
        AND ci.status NOT IN ('paid', 'cancelled')
        AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005`,
    [cid, saleId]
  );
  return r2(rows[0] && rows[0].restante);
}

// ─── POST /service-orders/:osId/notify-ready ─────────────────
// Aviso "oculos prontos" na mao (o automatico e o wa_ready_auto do status).
// Nunca 500 por WhatsApp: ver avisarOculosProntos().
router.post('/:osId/notify-ready', async function (req, res) {
  const cid = req.params.id;
  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    if (os.kind !== 'otica') {
      return res.status(400).json({ error: 'Aviso de oculos prontos so existe em OS de otica', code: 'OS_NAO_E_OTICA' });
    }
    exigirGate(flags, 'otica');
    if (os.status !== 'pronta') {
      return res.status(409).json({
        error: 'A OS precisa estar pronta para avisar o cliente',
        code: 'OS_NAO_PRONTA',
        status: os.status,
      });
    }
    res.json(await avisarOculosProntos(os, cid));
  } catch (err) {
    falhar(res, err, 'POST:notify-ready');
  }
});

// ─── DELETE /service-orders/:osId ────────────────────────────
// So OS recem-aberta e sem venda. Depois que o aparelho entrou em execucao a
// OS e historico do que aconteceu com um bem de terceiro — cancela, nao apaga.
router.delete('/:osId', async function (req, res) {
  const cid = req.params.id;
  try {
    const flags = await lerFlagsDoModulo(cid);
    const os = await carregarOs(req.params.osId, cid);
    if (!os) return res.status(404).json({ error: 'Ordem de servico nao encontrada' });
    exigirGate(flags, os.kind);

    if (os.status !== 'aberta' || os.sale_id) {
      return res.status(409).json({
        error: 'So OS aberta e sem venda pode ser excluida. Use o cancelamento.',
        code: 'OS_NAO_EXCLUIVEL',
      });
    }

    await db.query('DELETE FROM service_orders WHERE id = $1 AND company_id = $2', [os.id, cid]);
    res.json({ deleted: true });
  } catch (err) {
    falhar(res, err, 'DELETE');
  }
});

module.exports = router;
module.exports.TRANSICOES = TRANSICOES;
module.exports.LAB_TRANSICOES = LAB_TRANSICOES;
module.exports._validarOptical = validarOptical;
// So para teste: o cache do schema e module-level e sobrevive entre casos.
module.exports._resetSchemaCache = function () { _schemaOtica = null; _schemaOticaAte = 0; };
