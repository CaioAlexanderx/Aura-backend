// ============================================================
// AURA Studio — A confirmacao do pedido, lida pelo token (Fase 2 · BE-2)
//
// Ate aqui a confirmacao so existia na memoria da aba: um F5 apagava o
// pedido da tela, e o poll por id (GET /studio/order/:oid) nao devolvia
// o codigo do Pix — recarregar nao tinha como mostrar o QR de novo
// (FASEAMENTO_VITRINE_STUDIO.md §3.3). Agora a pagina
// `<loja>/pedido/<token>` le tudo do servidor.
//
// O token (digital_orders.public_token, migration 322) E a credencial: a
// pagina abre sem login e o link pode ser reencaminhado. Por isso o que
// NAO sai daqui importa mais que o que sai — a mesma lista do
// acompanhamento (studioTrackPublic.js):
//   - telefone, e-mail, CPF/CNPJ do cliente
//   - endereco completo (so bairro e cidade, para "vai chegar onde?")
//   - sobrenome (so o primeiro nome)
//   - nome e placa do entregador (so se ainda falta informar)
//
// Pura de proposito: a rota busca as linhas, isto monta a resposta, e o
// teste exercita a montagem sem banco.
// ============================================================
'use strict';

const { etapaDoStatus, etapasComEstado } = require('./etapasDoPedido');
const { ehCampoDeServicoDeArte, prazoDaSacola, r2 } = require('./precoDoStudio');

// Horas ate o Pix pendente do Studio cancelar sozinho (decisao do PO,
// 25/09/2026). Quem cancela e o job; a tela so repete o prazo dele.
const { PRAZO_HORAS_STUDIO: PRAZO_PIX_STUDIO_HORAS } = require('../jobs/lojaPixExpiradoJob');

const PAGAMENTO_PENDENTE = new Set(['pending_payment', 'awaiting_approval']);
const PAGO = new Set(['confirmed', 'paid', 'received']);

function primeiroNome(nome) {
  const n = String(nome || '').trim().split(/\s+/)[0];
  return n || null;
}

const curto = (v, max = 40) => {
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/**
 * A personalizacao em poucas palavras, como a cliente escolheu:
 * "Frente e verso", "Cor: Rosa", "Arte: Mãe", "Arte enviada".
 *
 * Endereco de arquivo nao sai (a confirmacao mostra a miniatura, nao o
 * link do upload), hex de cor sem nome tambem nao — e cabem no maximo
 * quatro linhas, porque isto e um resumo, nao a ficha de producao.
 */
function resumoDaPersonalizacao(cfg, customization) {
  const v = customization && typeof customization === 'object' ? customization : {};
  const out = [];
  if (v.has_back_selected === true) out.push('Frente e verso');
  if (v.has_middle_selected === true) out.push('Com faixa central');
  const campos = cfg && Array.isArray(cfg.fields) ? cfg.fields : [];
  let arteEnviada = false;
  for (const f of campos) {
    if (!f || !f.id) continue;
    const valor = v[f.id];
    if (valor == null || (typeof valor === 'string' && !valor.trim())) continue;
    const rotulo = typeof f.label === 'string' && f.label.trim() ? f.label.trim() : null;
    if (f.type === 'image' || f.type === 'template') {
      arteEnviada = true;
      continue;
    }
    if (f.type === 'option' || f.type === 'color') {
      const choices = f.config && Array.isArray(f.config.choices) ? f.config.choices : [];
      const sel = Array.isArray(valor) ? valor : [valor];
      const nomes = sel
        .map((s) => choices.find((c) => c.value === s || c.label === s))
        .filter(Boolean)
        .map((c) => c.label);
      if (!nomes.length) continue;
      if (ehCampoDeServicoDeArte(f)) {
        // "Vou enviar minha arte pronta" nao e escolha que valha linha.
        if (sel.every((s) => s === 'none')) continue;
        out.push(curto(nomes.join(', ')));
      } else {
        out.push(curto(rotulo ? `${rotulo}: ${nomes.join(', ')}` : nomes.join(', ')));
      }
      continue;
    }
    if (f.type === 'text') {
      // O briefing do servico de arte e texto longo para a lojista.
      if (f.config && f.config.is_art_service === true) continue;
      out.push(curto(rotulo ? `${rotulo}: ${valor}` : String(valor)));
    }
  }
  if (arteEnviada) out.push('Arte enviada');
  return out.slice(0, 4);
}

/** Quando o Pix pendente do Studio cancela sozinho. */
function expiracaoDoPix(criadoEm) {
  const t = new Date(criadoEm).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + PRAZO_PIX_STUDIO_HORAS * 3600 * 1000).toISOString();
}

/**
 * @param {object} p
 * @param {object} p.pedido   linha de digital_orders (+ colunas opcionais)
 * @param {Array}  p.itens    linhas de digital_order_items (+ customization_config do produto)
 * @param {object} p.loja     digital_channel_config (+ company_display_name)
 * @param {object} p.studioSettings companies.studio_settings
 * @param {object} p.faixas   mapa de faixas (precoDoStudio.carregarFaixas)
 * @param {string} p.acompanharUrl
 */
function montarConfirmacao({ pedido, itens, loja, studioSettings, faixas, acompanharUrl }) {
  const o = pedido || {};
  const ss = studioSettings || {};
  const cfg = loja || {};
  const status = o.status || null;
  const pagamento = o.payment_method || null;
  const pendente = PAGAMENTO_PENDENTE.has(status)
    && !PAGO.has(String(o.payment_status || '').toLowerCase());

  const tipo = o.delivery_type || 'pickup';
  const retirada = tipo === 'pickup' || tipo === 'courier';
  const bairroCidade = tipo === 'delivery'
    ? [o.address_neighborhood, o.address_city].map((x) => (x ? String(x).trim() : '')).filter(Boolean).join(' · ') || null
    : null;

  // Pix na tela so enquanto ha o que pagar: pago, cancelado ou "ja
  // paguei" (awaiting_approval) nao mostram mais o codigo.
  const pix = pagamento === 'pix' && status === 'pending_payment'
    && !PAGO.has(String(o.payment_status || '').toLowerCase())
    && o.asaas_pix_payload
    ? {
        qrcode: o.asaas_pix_qrcode || null,
        copia_e_cola: o.asaas_pix_payload,
        // O que a cliente precisa saber e quando o pedido cancela: e o
        // prazo da decisao do PO, o mesmo que o job de Pix vencido usa.
        expira_em: expiracaoDoPix(o.created_at),
        // Pix manual (chave da lojista) e loja de teste: ninguem confirma
        // sozinho, a lojista confere — a tela oferece "Ja paguei".
        modo: /^(manual|teste)-/.test(String(o.asaas_payment_id || '')) ? 'manual' : 'auto',
      }
    : null;

  // `cartao` fica sempre null por ora: o init_point do Mercado Pago so
  // volta na resposta do POST e nao e guardado no pedido (nao ha coluna).
  // Guardar exigiria migration; a volta do cartao no app usa o
  // ?order_id=&payment= do back_url, que ja existe.
  const cartao = null;

  // Enquanto o pagamento nao entrou, o pedido esta em "Pedido recebido":
  // a lojista nao comeca a arte de um pedido que ainda nao foi pago. O
  // cancelado tambem para ali — o app mostra o cancelamento pelo `status`,
  // e a linha do tempo nao pode dizer "Criando a arte" num pedido morto.
  const atual = pendente || status === 'cancelled' ? 0 : etapaDoStatus(o.studio_production_status);

  const linhas = (itens || []).map((i) => ({
    nome: i.product_name,
    quantidade: parseInt(i.quantity, 10) || 0,
    preco_unitario: r2(i.unit_price),
    total: r2(i.subtotal),
    imagem_url: i.product_image || null,
    resumo: resumoDaPersonalizacao(i.customization_config, i.customization),
  }));

  const subtotal = r2(o.subtotal);
  const frete = r2(o.delivery_fee);
  // So existe desconto do Pix no pedido da vitrine (migration 316).
  // Base sem a coluna: undefined vira 0.
  const descontoPix = r2(o.discount_amount);

  return {
    numero: o.order_number != null ? String(o.order_number) : null,
    criado_em: o.created_at || null,
    cliente_primeiro_nome: primeiroNome(o.customer_name),
    status,
    payment_status: o.payment_status || null,
    payment_method: pagamento,
    subtotal,
    desconto_pix: descontoPix,
    frete,
    total: r2(o.total),
    entrega: {
      tipo,
      prazo_texto: (tipo === 'delivery' ? cfg.delivery_eta_text : cfg.pickup_eta_text) || null,
      retirada_endereco: retirada ? (cfg.address || null) : null,
      bairro_cidade: bairroCidade,
      courier_a_informar: tipo === 'courier' && !o.courier_name,
    },
    itens: linhas,
    pix,
    cartao,
    comprovante_enviado: !!o.payment_proof_url,
    etapas: etapasComEstado(atual),
    prazo_dias_uteis: prazoDaSacola(
      ss.default_sla_days,
      (itens || []).map((i) => ({
        quantidade: parseInt(i.quantity, 10) || 0,
        faixas: faixas ? (faixas[i.product_id] ?? faixas.__global ?? null) : null,
      }))
    ),
    revisoes: {
      max_included: ss.max_revisions_included != null ? parseInt(ss.max_revisions_included, 10) : 0,
      extra_price: ss.extra_revision_price != null ? parseFloat(ss.extra_revision_price) : 0,
      policy_text: ss.revision_policy_text || null,
    },
    acompanhar_url: acompanharUrl || null,
    loja: {
      nome: cfg.site_name || cfg.company_display_name || null,
      whatsapp: cfg.whatsapp || cfg.phone || ss.approval_wa_phone || null,
    },
  };
}

module.exports = {
  PRAZO_PIX_STUDIO_HORAS,
  resumoDaPersonalizacao,
  expiracaoDoPix,
  montarConfirmacao,
};
