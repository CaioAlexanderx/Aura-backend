// ============================================================
// AURA Studio — Acompanhamento publico da encomenda (K3)
// 18/08/2026
//
// Rota SEM auth, no mesmo padrao de studioApprovalPublic.js: o token e a
// credencial. Montada em index.js como /acompanhar/:token.
//
// Por que existe: o cliente de encomenda espera dias e nao tem como saber
// em que pe esta. A duvida vira mensagem no WhatsApp da lojista, varias
// vezes ao dia. A pesquisa de operational transparency (Buell/HBS) mediu
// +22% de qualidade percebida quando o cliente VE o trabalho acontecendo.
//
// O QUE NAO SAI DAQUI (a lista importa mais que a de campos expostos):
//   - CPF/CNPJ, telefone, e-mail e endereco do cliente
//   - sobrenome completo (so primeiro nome -- link pode ser reencaminhado)
//   - custo, margem, vendedor, desconto, forma de pagamento
//   - qualquer id interno alem do proprio pedido
//
// E, deliberadamente, NAO ha previsao de horario. O tracker mostra ETAPA e,
// quando existe, a data combinada. Prometer hora e o erro classico do
// genero (a propria industria do pizza tracker aprendeu isso): previsao
// furada destroi mais confianca do que a ausencia dela.
// ============================================================
const router = require('express').Router();
const db = require('../config/database');
const { resolvePixSetup } = require('../services/credit/collectionNotice');
const { buildStaticBrCode, sanitizeTxid } = require('../services/staticPixService');

// As etapas que o CLIENTE entende. O board tem 6 colunas operacionais;
// aqui viram 4 marcos, porque "aprovado" e "em producao" sao a mesma
// promessa pra quem espera: esta sendo feito.
const ETAPAS = [
  { key: 'recebido',  label: 'Pedido recebido' },
  { key: 'arte',      label: 'Criando a arte' },
  { key: 'producao',  label: 'Em produção' },
  { key: 'pronto',    label: 'Pronto' },
];

// status de producao -> indice da etapa concluida
function etapaDoStatus(status) {
  switch (status) {
    case 'awaiting_customization': return 0;
    case 'pending_art':            return 1;
    case 'approved':
    case 'in_production':          return 2;
    case 'ready':
    case 'delivered':              return 3;
    default:                       return 0; // venda sem producao: so "recebido"
  }
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'você';

// ── Pedido da VITRINE (05/09/2026) ──────────────────────────────────────
//
// O token do balcao mora em sales; o da vitrine, em digital_orders
// (migration 322). Sao duas tabelas porque sao dois caminhos de venda, e
// o cliente nao sabe nem precisa saber por qual entrou: a pagina e a
// mesma. Aqui o pedido digital e traduzido para o MESMO formato da venda,
// com a mesma lista de coisas que nao saem (CPF, telefone, endereco,
// sobrenome, forma de pagamento).
//
// Sem `saldo`: o pedido da vitrine e pago integral (Pix ou cartao) ou
// combinado na entrega — nao ha parcela de sinal para cobrar aqui.
async function pedidoDaVitrine(token) {
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.order_number, o.company_id, o.created_at, o.total, o.status,
              o.studio_production_status, o.customer_name,
              COALESCE(co.trade_name, co.legal_name) AS loja,
              (SELECT json_agg(json_build_object('nome', i.product_name, 'qtd', i.quantity) ORDER BY i.id)
                 FROM digital_order_items i WHERE i.order_id = o.id) AS itens,
              (SELECT i2.product_image FROM digital_order_items i2
                WHERE i2.order_id = o.id AND NULLIF(TRIM(i2.product_image), '') IS NOT NULL
                ORDER BY i2.id LIMIT 1) AS imagem
         FROM digital_orders o
         LEFT JOIN companies co ON co.id = o.company_id
        WHERE o.public_token = $1
        LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  } catch (e) {
    // Antes da migration 322 a coluna nao existe: o link do balcao segue
    // funcionando e o da vitrine ainda nao foi gerado por ninguem.
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

// ── Ordem de Servico (15/09/2026, migration 334) ────────────────────────
//
// Terceiro caminho: o token mora em service_orders.tracker_token. A otica
// e o caso que pediu isso (o cliente espera a lente voltar do laboratorio
// por uma semana), mas a OS de reparo tambem tem token e ganha o mesmo
// tracker com etapas proprias. Mesma lista do que NAO sai — e, na otica,
// mais tres coisas: receita, prescritor e laboratorio. Receita e dado de
// saude; o link pode ser reencaminhado.
//
// `tipo: 'oculos'` so na OS de otica: o front troca "sua encomenda" por
// "seus oculos" com isso. A venda e a vitrine nao levam o campo.
const ETAPAS_OTICA = [
  { key: 'recebido',    label: 'Pedido recebido' },
  { key: 'laboratorio', label: 'Lentes no laboratório' },
  { key: 'montagem',    label: 'Montagem e conferência' },
  { key: 'pronto',      label: 'Pronto para retirar' },
];

const ETAPAS_REPARO = [
  { key: 'recebido', label: 'Equipamento recebido' },
  { key: 'execucao', label: 'Em execução' },
  { key: 'pronto',   label: 'Pronto para retirar' },
];

function etapaDaOs(os) {
  if (os.kind === 'otica') {
    if (os.status === 'pronta' || os.status === 'entregue') return 3;
    switch (os.lab_status) {
      case 'no_laboratorio':
      case 'refacao':      return 1;
      case 'recebida':
      case 'em_montagem':  return 2;
      default:             return 0; // aberta / aguardando_envio
    }
  }
  switch (os.status) {
    case 'em_execucao': return 1;
    case 'pronta':
    case 'entregue':    return 2;
    default:            return 0;
  }
}

async function ordemDeServico(token) {
  try {
    const { rows } = await db.query(
      `SELECT so.id, so.os_number, so.company_id, so.created_at, so.status,
              so.kind, so.lab_status, so.promised_at, so.estimated_amount,
              so.deposit_sale_id,
              cu.name AS customer_name,
              COALESCE(co.trade_name, co.legal_name) AS loja,
              (SELECT json_agg(json_build_object('nome', i.description, 'qtd', i.quantity)
                               ORDER BY i.sort_order, i.created_at)
                 FROM service_order_items i WHERE i.service_order_id = so.id) AS itens
         FROM service_orders so
         LEFT JOIN customers cu ON cu.id = so.customer_id
         LEFT JOIN companies co ON co.id = so.company_id
        WHERE so.tracker_token = $1
        LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  } catch (e) {
    // Antes da 334 nao ha token de OS: os outros dois caminhos seguem.
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

async function respostaDaOs(os) {
  const oculos = os.kind === 'otica';
  const pedido = `OS ${os.os_number != null ? os.os_number : String(os.id).slice(0, 8).toUpperCase()}`;
  const base = { loja: os.loja, cliente: primeiroNome(os.customer_name), pedido };
  if (oculos) base.tipo = 'oculos';

  if (os.status === 'cancelada') return { cancelado: true, ...base };

  // Saldo do sinal: a venda que registrou o sinal fica em deposit_sale_id
  // e o saldo esta em credit_installments, igual a encomenda do Studio.
  const saldo = os.deposit_sale_id
    ? await saldoEmAberto(os.company_id, os.deposit_sale_id, 'OS')
    : null;

  return {
    cancelado: false,
    ...base,
    criado_em: os.created_at,
    entrega_combinada: os.promised_at
      ? new Date(os.promised_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
      : null,
    imagem:    null,
    itens:     os.itens || [],
    total:     parseFloat(os.estimated_amount) || 0,
    etapa_atual: etapaDaOs(os),
    etapas:      oculos ? ETAPAS_OTICA : ETAPAS_REPARO,
    saldo,
  };
}

// Parcela em aberto (venda com sinal) + Pix copia-e-cola. Defensivo: sem a
// tabela, o acompanhamento continua funcionando -- so nao mostra saldo.
// Falha no Pix tambem nao derruba nada.
async function saldoEmAberto(companyId, saleId, txidPrefix) {
  let saldo = null;
  try {
    const { rows: br } = await db.query(
      `SELECT ci.id,
              ROUND((ci.amount_due - COALESCE(ci.covered_amount, 0))::numeric, 2) AS valor,
              ci.due_date
         FROM credit_installments ci
        WHERE ci.company_id = $1 AND ci.sale_id = $2
          AND ci.status NOT IN ('paid', 'cancelled')
          AND (ci.amount_due - COALESCE(ci.covered_amount, 0)) > 0.005
        ORDER BY ci.due_date ASC LIMIT 1`,
      [companyId, saleId]
    );
    if (br.length) {
      saldo = {
        valor:      parseFloat(br[0].valor),
        vencimento: br[0].due_date,
        pix:        null,
      };
      try {
        const pix = await resolvePixSetup(companyId);
        if (pix && saldo.valor > 0) {
          saldo.pix = buildStaticBrCode({
            pixKey:          pix.pixKey,
            amount:          saldo.valor,
            beneficiaryName: pix.name,
            beneficiaryCity: pix.city,
            txid:            sanitizeTxid(txidPrefix + String(saleId).replace(/-/g, '')),
          });
        }
      } catch (_) { /* segue sem Pix */ }
    }
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  return saldo;
}

// ── Entrega do Matcon (23/09/2026, migration 352) ───────────────────────
//
// Quarto caminho: o token mora em matcon_deliveries.public_token — uma
// entrega (viagem do caminhao) de uma venda de material de construcao. A
// pagina mostra o PEDIDO inteiro, nao so aquela viagem: o cliente quer
// saber "ja chegou tudo?". Mesma lista do que nao sai (CPF, telefone,
// ENDERECO de entrega, sobrenome, forma de pagamento, motorista).
//
// Etapas: aprovado -> separando -> pronto -> saiu -> entregue. A etapa
// atual e a da proxima viagem ainda aberta (a de menor sequence); sem
// nenhuma aberta, o pedido esta entregue.
//
// Itens: todo item leva `quantidade` (= qtd) e `unidade` (unit do
// produto; sale_items nao tem unidade propria) desde a primeira etapa —
// sem isso o app mostrava "1x" pra 1 milheiro (QA 23/09). Enquanto nenhuma
// viagem foi entregue, a data combinada vai em `entrega_combinada`. Depois
// da primeira viagem entregue (entrega parcial), cada item ganha tambem
// entregue/total ("6 de 10 sc") e a data da proxima viagem vai em
// `proxima_entrega` — o app so fala em "restantes na proxima viagem"
// quando esses campos vem.
const ETAPAS_ENTREGA = [
  { key: 'aprovado',  label: 'Pedido aprovado' },
  { key: 'separando', label: 'Separando o material' },
  { key: 'pronto',    label: 'Pronto para sair' },
  { key: 'saiu',      label: 'Saiu para entrega' },
  { key: 'entregue',  label: 'Entregue' },
];

const ETAPA_DO_STAGE = { separating: 1, ready: 2, out: 3, delivered: 4 };

async function entregaMatcon(token) {
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.sale_id, d.company_id, d.cancelled_at,
              s.status AS sale_status, s.sale_number, s.total_amount, s.created_at,
              COALESCE(d.customer_name, cu.name) AS customer_name,
              COALESCE(co.trade_name, co.legal_name) AS loja,
              CASE WHEN ne.status = 'autorizada' THEN ne.pdf_url END AS danfe_url
         FROM matcon_deliveries d
         JOIN sales s ON s.id = d.sale_id
         LEFT JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN companies co ON co.id = d.company_id
         LEFT JOIN nfce_emissions ne ON ne.id = d.nfe_emission_id
        WHERE d.public_token = $1
        LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  } catch (e) {
    // Antes da 352 nao ha entrega: os outros caminhos seguem.
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

async function respostaDaEntrega(d) {
  const pedido = d.sale_number != null ? String(d.sale_number) : String(d.sale_id).slice(0, 8).toUpperCase();
  const base = { loja: d.loja, cliente: primeiroNome(d.customer_name), pedido, tipo: 'entrega' };
  if (d.cancelled_at || String(d.sale_status || '').toLowerCase() === 'cancelled') {
    return { cancelado: true, ...base };
  }

  const { rows: viagens } = await db.query(
    `SELECT stage, sequence, to_char(scheduled_for, 'YYYY-MM-DD') AS scheduled_for
       FROM matcon_deliveries
      WHERE sale_id = $1 AND cancelled_at IS NULL
      ORDER BY sequence`,
    [d.sale_id]
  );
  const { rows: itens } = await db.query(
    `SELECT COALESCE(si.product_name_snapshot, p.name, 'Item') AS nome,
            si.quantity AS total, p.unit AS unidade,
            COALESCE((SELECT SUM(di.quantity)
                        FROM matcon_delivery_items di
                        JOIN matcon_deliveries x ON x.id = di.delivery_id
                       WHERE di.sale_item_id = si.id AND x.cancelled_at IS NULL
                         AND x.stage = 'delivered'), 0) AS entregue
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY si.id`,
    [d.sale_id]
  );

  const aberta = viagens.find((v) => v.stage !== 'delivered') || null;
  const algumaEntregue = viagens.some((v) => v.stage === 'delivered');
  const etapaAtual = aberta ? (ETAPA_DO_STAGE[aberta.stage] || 1) : 4;

  const saldo = await saldoEmAberto(d.company_id, d.sale_id, 'ENT');

  return {
    cancelado: false,
    ...base,
    criado_em: d.created_at,
    entrega_combinada: !algumaEntregue && aberta ? aberta.scheduled_for : null,
    imagem:    null,
    itens: itens.map((it) => {
      const qtd = parseFloat(it.total) || 0;
      const linha = { nome: it.nome, qtd, quantidade: qtd, unidade: it.unidade || null };
      if (!algumaEntregue) return linha;
      return {
        ...linha,
        entregue: parseFloat(it.entregue) || 0,
        total:    qtd,
      };
    }),
    total:       parseFloat(d.total_amount) || 0,
    etapa_atual: etapaAtual,
    etapas:      ETAPAS_ENTREGA,
    saldo,
    proxima_entrega: algumaEntregue && aberta ? aberta.scheduled_for : null,
    danfe_url:   d.danfe_url || null,
  };
}

function respostaDoPedidoDaVitrine(o) {
  const pedido = String(o.order_number || o.id).toUpperCase();
  if (String(o.status || '').toLowerCase() === 'cancelled') {
    return { cancelado: true, loja: o.loja, cliente: primeiroNome(o.customer_name), pedido };
  }
  return {
    cancelado: false,
    loja:      o.loja,
    cliente:   primeiroNome(o.customer_name),
    pedido,
    criado_em: o.created_at,
    entrega_combinada: null,
    imagem:    o.imagem,
    itens:     o.itens || [],
    total:     parseFloat(o.total) || 0,
    etapa_atual: etapaDoStatus(o.studio_production_status),
    etapas:      ETAPAS,
    saldo:       null,
  };
}

router.get('/:token', async function(req, res) {
  const token = String(req.params.token || '').trim();
  // Token curto nem chega ao banco: evita varredura barata.
  if (token.length < 16) return res.status(404).json({ error: 'Acompanhamento nao encontrado.' });

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.company_id, s.created_at, s.total_amount, s.status,
              s.studio_production_status, s.promised_date,
              cu.name AS customer_name,
              COALESCE(co.trade_name, co.legal_name) AS loja,
              (SELECT json_agg(json_build_object(
                 'nome', COALESCE(p.name, si.product_name_snapshot),
                 'qtd',  si.quantity
               ) ORDER BY si.id)
                 FROM sale_items si
                 LEFT JOIN products p ON p.id = si.product_id
                WHERE si.sale_id = s.id) AS itens,
              (SELECT p.image_url FROM sale_items si2
                 JOIN products p ON p.id = si2.product_id
                WHERE si2.sale_id = s.id
                  AND NULLIF(TRIM(p.image_url), '') IS NOT NULL
                ORDER BY si2.id LIMIT 1) AS imagem
         FROM sales s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN companies co ON co.id = s.company_id
        WHERE s.tracker_token = $1
        LIMIT 1`,
      [token]
    );

    if (!rows.length) {
      const pedido = await pedidoDaVitrine(token);
      if (pedido) return res.json(respostaDoPedidoDaVitrine(pedido));
      const os = await ordemDeServico(token);
      if (os) return res.json(await respostaDaOs(os));
      const entrega = await entregaMatcon(token);
      if (entrega) return res.json(await respostaDaEntrega(entrega));
      return res.status(404).json({ error: 'Acompanhamento nao encontrado.' });
    }
    const v = rows[0];

    // Venda cancelada nao vira 404: o cliente merece saber que foi cancelada,
    // e nao ficar olhando um tracker parado achando que esta em producao.
    if (String(v.status || '').toLowerCase() === 'cancelled') {
      return res.json({
        cancelado: true,
        loja: v.loja,
        cliente: primeiroNome(v.customer_name),
        pedido: String(v.id).slice(0, 8).toUpperCase(),
      });
    }

    const etapaAtual = etapaDoStatus(v.studio_production_status);

    // Saldo em aberto (venda com sinal) — ver saldoEmAberto().
    const saldo = await saldoEmAberto(v.company_id, v.id, 'ENC');

    return res.json({
      cancelado: false,
      loja:      v.loja,
      cliente:   primeiroNome(v.customer_name),
      pedido:    String(v.id).slice(0, 8).toUpperCase(),
      criado_em: v.created_at,
      entrega_combinada: v.promised_date,
      imagem:    v.imagem,
      itens:     v.itens || [],
      total:     parseFloat(v.total_amount) || 0,
      etapa_atual: etapaAtual,
      etapas:      ETAPAS,
      saldo,
    });
  } catch (err) {
    console.error('[studio/acompanhar]', err.message);
    return res.status(500).json({ error: 'Erro ao carregar o acompanhamento.' });
  }
});

module.exports = router;
module.exports._etapaDoStatus = etapaDoStatus;
module.exports._primeiroNome = primeiroNome;
module.exports._ETAPAS = ETAPAS;
module.exports._respostaDoPedidoDaVitrine = respostaDoPedidoDaVitrine;
module.exports._etapaDaOs = etapaDaOs;
module.exports._ETAPAS_OTICA = ETAPAS_OTICA;
module.exports._respostaDaEntrega = respostaDaEntrega;
module.exports._ETAPAS_ENTREGA = ETAPAS_ENTREGA;
