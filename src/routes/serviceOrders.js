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
const {
  assertOticaEnabled, erroOticaDesligada, carregarOticaSettings, OTICA_DEFAULTS, waParam, primeiroNome,
} = require('./otica');
const waOutbox = require('../services/waOutbox');

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

const USOS = ['longe', 'perto', 'multifocal', 'bifocal'];

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
         ds.total_amount AS deposit_sale_total
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
    ? `${process.env.APP_PUBLIC_URL || ''}/acompanhar/${os.tracker_token}`
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

    // Cliente tem que ser DESTA empresa — sem isso, um customer_id de outra
    // empresa passaria pela FK (que so olha customers.id) e a OS nasceria
    // apontando pra fora do tenant.
    const cust = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
      [customer_id, cid]
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
          'SELECT id FROM sales WHERE id = $1 AND company_id = $2',
          [sale_id, cid]
        );
        if (!venda.rows.length) {
          return res.status(404).json({ error: 'Venda nao encontrada nesta empresa' });
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
