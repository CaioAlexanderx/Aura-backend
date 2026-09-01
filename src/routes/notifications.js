// ============================================================
// AURA. — Notificações do App (empresa)
// GET  /companies/:id/notifications                        — banners + eventos + pedidos recentes
// POST /companies/:id/notifications/banners/:nid/read     — marca banner como lido
// POST /companies/:id/notifications/:nid/read             — idem, forma curta (app)
// POST /companies/:id/notifications/events/:nid/read      — idem, alias para evento
// POST /companies/:id/notifications/read-all-banners      — marca todos como lidos
// POST /companies/:id/notifications/read-all              — idem, nome que o app usa
// GET  /companies/:id/notifications/preferences           — quais eventos a empresa recebe
// PUT  /companies/:id/notifications/preferences           — liga/desliga eventos
//
// Criado: 13/06/2026
// Fix    13/06/2026: companies.plan é enum plan_type; target_plan é TEXT.
//   Postgres recusa "text = plan_type" sem cast explícito → plan::text.
// Fix    24/06/2026: o bloco de pedidos do Studio selecionava colunas que NÃO
//   existem na VIEW studio_orders (`order_number`, `total`). A view expõe
//   `total_amount` e, como rótulo, `display_name` — não há número de pedido.
//   A query antiga lançava `column "order_number" does not exist` a cada poll
//   de /notifications (30s) de TODA empresa, floodando os logs do Postgres; e
//   por rodar dentro de um catch silencioso, as notificações de pedido do
//   Studio nunca apareciam. Agora usamos as colunas reais e expomos
//   display_name (ou o id curto) como order_number pro card do app.
//
// 18/08/2026 — EXPANSÃO PARA AURA DOJÔ / KARATÊ / STUDIO (migration 285).
//   Esta rota já respondia para os três shells (é montada em private.js para
//   TODA empresa, sem gate de plano), mas o banner só sabia segmentar por
//   empresa e por plano. Sem alvo de shell, um aviso do Aura Dojô aparecia
//   também na loja de varejo. Agora o banner casa com o SHELL da empresa:
//
//     shell = COALESCE(vertical_active, vertical, 'negocio')
//
//   e `target_vertical IS NULL` segue significando "todos os shells" — o
//   comportamento de todo banner que já existe. Lista de shells válidos:
//   src/services/appNotifications.js (SHELLS), que é também por onde o
//   BACKEND dispara banner sem passar pela Gestão Aura.
//
//   `vertical_active` é o campo que a Gestão Aura liga (adminVertical.js) e
//   `vertical` é o do cadastro do dojô/federação (auth.js) — daí o COALESCE
//   nessa ordem. O único Studio da base hoje tem vertical NULL e
//   vertical_active 'studio'; os dojôs têm os dois preenchidos.
//
//   Defensivo (CLAUDE.md, armadilha 1): antes da migration 285 a coluna
//   target_vertical não existe. Em 42703 a query cai na forma antiga e o
//   cache module-level evita repetir o try/catch a cada poll de 30s.
//
// 01/09/2026 — EVENTOS DURÁVEIS DA LOJA ONLINE (migration 315).
//   O bloco 2 (digital_orders das últimas 24h) é polling de JANELA, não log:
//   quem não abre o app em 24h perde o aviso, e nada do que acontece DEPOIS
//   do pedido (pagou, PIX expirou, chegou comprovante, saiu pra entrega,
//   entregue, cancelado) aparecia em lugar nenhum. Esses eventos agora são
//   linhas em app_notifications com type 'loja_<evento>' — duráveis, com
//   lido/não lido via notification_reads e dedupe por pedido.
//
//   O contrato antigo NÃO muda: `banners` continua sendo só o que a Gestão
//   Aura publica, porque as duas leituras se separam por type. Sem esse
//   corte, todo evento novo cairia dentro de `banners` e o app tentaria
//   renderizá-lo como card de endomarketing (html_content, CTA externo).
//   O que é aditivo: o array `events` e o `unread_count`, que passa a
//   somá-los.
//
//   `severity` de cada evento é DERIVADA do type em services/lojaEvents.js —
//   não há coluna no banco. O porquê está no cabeçalho de lá.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const lojaEvents = require('../services/lojaEvents');

// Corte entre as duas famílias de linha em app_notifications. ESCAPE '/'
// em vez de barra invertida: o '_' de 'loja_' é curinga em LIKE e o
// escape padrão vira ruído ao atravessar template string do JS.
const IS_LOJA_EVENT  = `n.type LIKE 'loja/_%' ESCAPE '/'`;
const NOT_LOJA_EVENT = `n.type NOT LIKE 'loja/_%' ESCAPE '/'`;

// null = ainda não sabemos; true/false = decidido para o resto do processo.
let hasTargetVertical = null;

// Filtro de alvo compartilhado pelo GET e pelo read-all — o write path tem
// que enxergar exatamente os mesmos banners que o read path (CLAUDE.md,
// armadilha 7), senão "marcar todas como lidas" cria linha de leitura para
// banner de outro shell e ele some se um dia for redirecionado.
function targetFilter(withVertical) {
  return `
        AND (n.expires_at IS NULL OR n.expires_at > NOW())
        AND (n.target_company_id IS NULL OR n.target_company_id = $1)
        AND (n.target_plan IS NULL OR n.target_plan = (
              SELECT plan::text FROM companies WHERE id = $1 LIMIT 1
            ))
        ${withVertical ? `AND (n.target_vertical IS NULL OR n.target_vertical = (
              SELECT COALESCE(vertical_active, vertical, 'negocio')
                FROM companies WHERE id = $1 LIMIT 1
            ))` : ''}`;
}

function bannersSql(withVertical) {
  return `
      SELECT n.id, n.type, n.title, n.body, n.html_content,
             n.cta_label, n.cta_url, n.cta_route, n.created_at
             ${withVertical ? ', n.target_vertical' : ''}
      FROM app_notifications n
      WHERE n.is_active = true
        AND ${NOT_LOJA_EVENT}
        ${targetFilter(withVertical)}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ORDER BY n.created_at DESC
      LIMIT 20`;
}

// Eventos da loja online. Mesmo filtro de alvo dos banners (é a mesma
// tabela), separado só pelo type — e sem html_content, que evento não tem.
// dedupe_key entra no SELECT porque é de onde sai o order_id do evento
// ('loja:<evento>:<order_id>'), poupando uma coluna nova só para isso.
function eventsSql(withVertical, withEntity) {
  return `
      SELECT n.id, n.type, n.title, n.body,
             n.cta_label, n.cta_url, n.cta_route, n.dedupe_key, n.created_at
             ${withEntity ? ', n.entity_ref, n.entity_label' : ''}
      FROM app_notifications n
      WHERE n.is_active = true
        AND ${IS_LOJA_EVENT}
        ${targetFilter(withVertical)}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ORDER BY n.created_at DESC
      LIMIT 30`;
}

// 'loja:pedido_pago:<uuid>' -> '<uuid>'. Eventos sem pedido
// (estoque_baixo, sem_pagamento_configurado) devolvem null.
function orderIdFromDedupeKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length < 3 || parts[0] !== 'loja') return null;
  const tail = parts.slice(2).join(':');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tail) ? tail : null;
}

// 01/09/2026: continua marcando TUDO que a empresa vê — banners E eventos —
// e por isso NÃO leva o corte por type. "Marcar todas como lidas" que
// deixasse metade da gaveta acesa seria pior que o problema que resolve; o
// write path segue enxergando exatamente a união dos dois read paths.
function readAllSql(withVertical) {
  return `
      INSERT INTO notification_reads (notification_id, company_id)
      SELECT n.id, $1
      FROM app_notifications n
      WHERE n.is_active = true
        ${targetFilter(withVertical)}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
          WHERE r.notification_id = n.id AND r.company_id = $1
        )
      ON CONFLICT (notification_id, company_id) DO NOTHING`;
}

// Roda a query na forma nova e, só em 42703 (migration 285 ausente),
// repete na forma antiga — memorizando a decisão.
async function runWithVerticalFallback(sqlFor, params) {
  try {
    const res = await db.query(sqlFor(hasTargetVertical !== false), params);
    if (hasTargetVertical === null) hasTargetVertical = true;
    return res;
  } catch (err) {
    if (err.code !== '42703') throw err;
    hasTargetVertical = false;
    return db.query(sqlFor(false), params);
  }
}

// Os eventos dependem de DUAS migrations distintas: 285 (dedupe_key,
// target_vertical) e 315 (entity_ref, entity_label). Um único flag não
// distingue as duas, e degradar a errada tira do feed mais do que precisa —
// por isso o degrade é em degraus: primeiro sem entidade (perde só o
// agrupamento dos cards), depois sem vertical.
let hasEntityCols = null;

async function runEvents(params) {
  try {
    const res = await db.query(eventsSql(hasTargetVertical !== false, hasEntityCols !== false), params);
    if (hasEntityCols === null) hasEntityCols = true;
    if (hasTargetVertical === null) hasTargetVertical = true;
    return res;
  } catch (err) {
    if (err.code !== '42703') throw err;
    hasEntityCols = false;
    try {
      return await db.query(eventsSql(hasTargetVertical !== false, false), params);
    } catch (err2) {
      if (err2.code !== '42703') throw err2;
      hasTargetVertical = false;
      return db.query(eventsSql(false, false), params);
    }
  }
}

// GET — Banners ativos (não lidos) + pedidos recentes das últimas 24h
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    // 1. Banners ativos não lidos por esta empresa, filtrados por empresa,
    // plano e shell. Nota: companies.plan é do tipo plan_type (enum); fazemos
    // cast ::text para comparar com a coluna target_plan TEXT.
    let { rows: banners } = await runWithVerticalFallback(bannersSql, [cid]);

    // A lojista pode desligar as "Novidades da Aura" (pseudo-preferência
    // app_banner). Ao contrário dos eventos, o gate aqui é na LEITURA: o
    // banner não é criado por empresa, é publicado para muitas de uma vez —
    // não há INSERT nosso para não fazer.
    if (!(await lojaEvents.isBannerEnabled(cid))) banners = [];

    // 1b. Eventos duráveis da loja online (migration 315). Mesma tabela,
    // mesmo filtro de alvo — separados por type. Ficam até serem lidos:
    // é log, não janela. severity vem do type (services/lojaEvents.js).
    let events = [];
    try {
      const { rows } = await runEvents([cid]);
      events = rows.map((e) => {
        const oid = orderIdFromDedupeKey(e.dedupe_key);
        return {
          id:           e.id,
          type:         e.type,
          severity:     lojaEvents.severityOf(e.type),
          title:        e.title,
          body:         e.body,
          cta_label:    e.cta_label,
          cta_url:      e.cta_url,
          cta_route:    e.cta_route,
          // entity_ref vem PREFIXADO ('pedido:<uuid>'). O fallback monta o
          // prefixo a partir da dedupe_key para o caso de a 315 ainda não ter
          // rodado — o app agrupa igual, só perde o entity_label.
          entity_id:    e.entity_ref || (oid ? `pedido:${oid}` : null),
          entity_label: e.entity_label || null,
          // A query só traz NÃO LIDOS; o campo existe para o app não precisar
          // de dois shapes quando um dia devolvermos o histórico lido.
          read_at:      null,
          order_id:     oid,
          created_at:   e.created_at,
        };
      });
    } catch (err) {
      // Último degrau: nem sem entidade nem sem vertical a query passou
      // (banco anterior à 285, sem dedupe_key). O feed antigo continua
      // inteiro em vez de a rota — e portanto o sino todo — virar 500.
      console.error('[notifications] eventos indisponíveis:', err.message);
    }

    // 2. Pedidos recentes do Canal Digital (últimas 24h)
    let digitalOrders = [];
    try {
      const { rows } = await db.query(`
        SELECT id, order_number, customer_name, total, status, created_at,
               'canal_digital' AS source
        FROM digital_orders
        WHERE company_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10
      `, [cid]);
      digitalOrders = rows;
    } catch (_) { /* plano sem Canal Digital ou tabela não existe */ }

    // 3. Pedidos recentes do Studio (últimas 24h)
    // fix (24/06/2026): a VIEW studio_orders não tem `order_number` nem `total`
    // — tem `total_amount` e `display_name`. A query antiga floodava os logs
    // com `column "order_number" does not exist`. Usamos as colunas reais e
    // expomos display_name (ou o id curto) como order_number pro card do app.
    //
    // 31/08/2026: source <> 'pdv'. Notificação avisa do que chegou DE FORA
    // (Canal Digital, pedido digital/marketplace do Studio). Venda de balcão
    // com produto personalizável entra na view via trigger (pending_art) —
    // certo pro KDS, que é fila de produção e continua mostrando — mas o
    // operador acabou de registrá-la com as próprias mãos; notificar é ruído.
    let studioOrders = [];
    try {
      const { rows } = await db.query(`
        SELECT id,
               COALESCE(display_name, LEFT(id::text, 8)) AS order_number,
               customer_name,
               total_amount AS total,
               status,
               created_at,
               'studio' AS source
        FROM studio_orders
        WHERE company_id = $1
          AND source <> 'pdv'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 10
      `, [cid]);
      studioOrders = rows;
    } catch (_) { /* view studio_orders não disponível neste ambiente */ }

    // Mescla e ordena por data desc.
    //
    // 31/08/2026 — dedup por id: um pedido de digital_orders com
    // vertical 'studio' vem nas DUAS queries — direto do bloco 2 e via
    // view studio_orders (primeiro ramo da view é digital_orders WHERE
    // vertical = 'studio'), com o MESMO id. O card do app usa key
    // id+source, então não colide — o pedido só aparece duplicado na
    // gaveta e conta dobrado no unread_count. Deduplicamos aqui (e não
    // com WHERE vertical <> 'studio' no bloco 2) porque a criação da
    // view é condicional (208: "deferida" sem marketplace_orders) — num
    // ambiente sem a view, o filtro SQL faria o pedido sumir do feed.
    // O card 'studio' vence por vir primeiro: roteia pro fluxo de
    // produção, o destino certo de um pedido do Studio.
    const byId = new Map();
    for (const o of [...studioOrders, ...digitalOrders]) {
      if (!byId.has(o.id)) byId.set(o.id, o);
    }
    const orders = [...byId.values()]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 15);

    // unread_count: banners não lidos + eventos não lidos + pedidos com menos de 2h
    const threshold = Date.now() - 2 * 60 * 60 * 1000;
    const newOrderCount = orders.filter(o => new Date(o.created_at).getTime() > threshold).length;
    const unread_count = banners.length + events.length + newOrderCount;

    // `events` é ADITIVO: banners/orders/unread_count seguem com o mesmo
    // nome e o mesmo significado que o app já consome.
    res.json({ banners, events, orders, unread_count });
  } catch (err) {
    console.error('[notifications] list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

// POST /banners/:nid/read — marca banner como lido (idempotente)
router.post('/banners/:nid/read', async (req, res) => {
  const { id: cid, nid } = req.params;
  try {
    await db.query(`
      INSERT INTO notification_reads (notification_id, company_id)
      VALUES ($1, $2)
      ON CONFLICT (notification_id, company_id) DO NOTHING
    `, [nid, cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// POST /read-all — mesmo handler do read-all-banners, com o nome que o app
// usa. O legado fica porque versões já publicadas do app chamam por ele.
router.post('/read-all', async (req, res) => {
  try {
    await runWithVerticalFallback(readAllSql, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read-all error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar todas como lidas' });
  }
});

// POST /read-all-banners — marca como lidos os banners que esta empresa
// de fato VÊ (mesmo filtro do GET: empresa + plano + shell + validade).
router.post('/read-all-banners', async (req, res) => {
  const cid = req.params.id;
  try {
    await runWithVerticalFallback(readAllSql, [cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read-all error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar todas como lidas' });
  }
});

// Uma linha de leitura serve banner e evento — é a mesma tabela.
async function marcarLida(cid, nid) {
  await db.query(`
    INSERT INTO notification_reads (notification_id, company_id)
    VALUES ($1, $2)
    ON CONFLICT (notification_id, company_id) DO NOTHING
  `, [nid, cid]);
}

// POST /:nid/read — forma curta, a que o app usa. Fica DEPOIS de
// /read-all e /preferences no arquivo, mas não colide com nenhuma: aquelas
// têm um segmento, esta tem dois.
router.post('/:nid/read', async (req, res) => {
  try {
    await marcarLida(req.params.id, req.params.nid);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// POST /events/:nid/read — alias de /banners/:nid/read.
// Evento e banner são a MESMA tabela e a MESMA notification_reads; o alias
// existe só para o app não ter que chamar uma rota chamada "banner" para
// dispensar um aviso de pedido.
router.post('/events/:nid/read', async (req, res) => {
  const { id: cid, nid } = req.params;
  try {
    await db.query(`
      INSERT INTO notification_reads (notification_id, company_id)
      VALUES ($1, $2)
      ON CONFLICT (notification_id, company_id) DO NOTHING
    `, [nid, cid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] event read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// ============================================================
// Preferências de evento (migration 315)
//
// Uma loja com 200 pedidos/dia não pode receber 200 sinos. O gate é na
// ESCRITA (services/lojaEvents.js checa antes do INSERT), então aqui só
// lemos/gravamos a tabela esparsa — ausência de linha = default do catálogo.
// ============================================================

// GET /preferences — { preferences: Record<type, boolean> } + catálogo.
//
// `preferences` é o Record que o app consome (combinado em 01/09/2026);
// `catalog` é aditivo e traz rótulo, dica, severidade e default de cada
// chave, para a tela de configuração não ter que duplicar a taxonomia.
// A chave 'app_banner' entra nos dois: é como se desliga as Novidades da Aura.
router.get('/preferences', async (req, res) => {
  const cid = req.params.id;
  try {
    res.json({
      preferences: await lojaEvents.prefsRecord(cid),
      catalog: await lojaEvents.effectivePrefs(cid),
    });
  } catch (err) {
    console.error('[notifications] prefs get error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar preferências de notificação' });
  }
});

// PUT /preferences — body: { preferences: { loja_pedido_entregue: true, ... } }
// Aceita parcial: só o que vier no body é gravado, o resto fica como está.
router.put('/preferences', async (req, res) => {
  const cid = req.params.id;
  const input = (req.body && req.body.preferences) || {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'preferences deve ser um objeto { tipo: boolean }' });
  }

  const entries = Object.entries(input);
  // Sem FK para um catálogo de tipos (o catálogo é o objeto congelado em
  // lojaEvents.js): quem valida é aqui. Sem isto um typo do app vira linha
  // morta na tabela e a preferência "não pega" — falha silenciosa.
  const invalid = entries.filter(([t, v]) => !lojaEvents.isPrefKey(t) || typeof v !== 'boolean');
  if (invalid.length) {
    return res.status(400).json({
      error: 'Preferência inválida: ' + invalid.map(([t]) => t).join(', '),
      valid_types: [...lojaEvents.TYPES, lojaEvents.APP_BANNER_KEY],
    });
  }

  try {
    for (const [type, enabled] of entries) {
      await db.query(`
        INSERT INTO company_notification_prefs (company_id, event_type, enabled, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (company_id, event_type)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
      `, [cid, type, enabled]);
    }
    // Cache de 60s desta instância; as outras expiram sozinhas.
    lojaEvents.invalidatePrefs(cid);
    res.json({
      ok: true,
      preferences: await lojaEvents.prefsRecord(cid),
      catalog: await lojaEvents.effectivePrefs(cid),
    });
  } catch (err) {
    console.error('[notifications] prefs put error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar preferências de notificação' });
  }
});

module.exports = router;
