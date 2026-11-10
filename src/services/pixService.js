// ============================================================
// AURA. — Pix Service para Canal Digital
//
// Ordem para gerar a cobranca Pix:
//   1. Pix MANUAL — chave Pix cadastrada em digital_channel_config (BR Code estatico)
//   2. Fora de producao: Mock (desenvolvimento e testes)
//   3. Em producao, sem chave valida: erro PIX_NOT_CONFIGURED (4xx) — o
//      chamador desfaz o pedido e a cliente escolhe outra forma de pagamento.
//
// Migration 088 adicionou pix_key/pix_key_type/pix_holder_name/pix_holder_city
// em digital_channel_config. Lojista cadastra a chave dele e a storefront
// gera o BR Code estatico apontando pra essa chave + valor + nome + cidade.
// Confirmacao e manual pela lojista (com comprovante anexado pelo cliente
// como nudge).
//
// RA-04 (10/11/2026): saiu o fallback legado de "subconta Asaas" que lia
// companies.asaas_subconta_id/asaas_subconta_token. Essas colunas nao existem
// no banco de producao (a migration 071 nunca chegou la): a consulta dava
// 42703 e o pedido da loja online caia em 500 — com o pedido ja gravado
// esperando um Pix que nao vinha. O Recebe na Aura tera tabela propria de
// subconta por empresa, em outro PR.
//
// E o Mock NUNCA sai em producao: o QR falso parece de verdade, a cliente
// pagaria um Pix que nao existe.
// ============================================================
'use strict';

const db = require('../config/database');
const { buildStaticBrCode, validatePixKey } = require('./staticPixService');

const PIX_NOT_CONFIGURED = 'PIX_NOT_CONFIGURED';
const MENSAGEM_PIX_NAO_CONFIGURADO =
  'O Pix desta loja ainda não está disponível. Por favor, escolha outra forma de pagamento.';

// Erro com codigo estavel: o chamador responde 422 { error, code } e desfaz
// o pedido (services/pedidoSemPix.js).
class PixNaoConfiguradoError extends Error {
  constructor(motivo) {
    super(MENSAGEM_PIX_NAO_CONFIGURADO);
    this.name = 'PixNaoConfiguradoError';
    this.code = PIX_NOT_CONFIGURED;
    this.status = 422;
    this.motivo = motivo || null;
  }
}

function emProducao() {
  return process.env.NODE_ENV === 'production';
}

async function generatePix({ order, company_id, total }) {
  // 1. Pix MANUAL — chave do lojista cadastrada
  const { rows: configs } = await db.query(
    `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city, site_name, address
     FROM digital_channel_config WHERE company_id = $1`,
    [company_id]
  );
  const cfg = configs[0];
  let motivo = 'sem_chave';
  if (cfg && cfg.pix_key && String(cfg.pix_key).trim()) {
    try {
      return generateManualPix({ order, total, cfg });
    } catch (err) {
      motivo = 'chave_invalida';
      console.warn('[PIX] Chave Pix da loja nao gerou o BR Code:', err.message);
    }
  }

  // 2. Producao: nada de QR falso.
  if (emProducao()) {
    throw new PixNaoConfiguradoError(motivo);
  }

  // 3. Mock — desenvolvimento/testes, sem chave configurada
  return generateMockPix({ order, total });
}

function generateManualPix({ order, total, cfg }) {
  // Normaliza chave conforme tipo (remove acentos/mascaras quando aplicavel)
  const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
  if (!validation.valid) {
    throw new Error('Chave Pix invalida: ' + validation.error);
  }
  const pixKey = validation.normalized;

  // Cidade: cai pro endereco da loja se pix_holder_city nao informado
  let city = cfg.pix_holder_city;
  if (!city && cfg.address) {
    // Tenta extrair cidade do address (formato livre — pega ultima virgula antes de UF)
    const parts = String(cfg.address).split(',').map(s => s.trim());
    city = parts[parts.length - 2] || parts[parts.length - 1] || '';
  }

  const payload = buildStaticBrCode({
    pixKey,
    amount: total,
    beneficiaryName: cfg.pix_holder_name || cfg.site_name || 'AURA NEGOCIO',
    beneficiaryCity: city || 'BRASIL',
    txid: order.order_number || order.id,
  });

  return {
    payment_id: 'manual-' + order.id,
    qrcode:     null,                  // frontend gera o QR a partir do payload
    payload:    payload,
    expires_at: null,                  // BR Code estatico nao expira
    mode:       'manual',
  };
}

function generateMockPix({ order, total }) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const ref       = String(order.order_number || '').replace('-', '').slice(0, 10).padEnd(10, '0');
  const amt       = Number(total).toFixed(2);
  const payload   = [
    '000201',
    '26580014br.gov.bcb.pix',
    `0136mock-${String(order.id).slice(0, 22)}`,
    '520400005303986',
    `5406${amt}`,
    '5802BR',
    '5920AURA NEGOCIO DIGITAL',
    '6009SAO PAULO',
    `6214051006${ref}`,
    '6304MOCK',
  ].join('');
  return { payment_id: `mock-${order.id}`, qrcode: null, payload, expires_at: expiresAt.toISOString(), mode: 'mock' };
}

module.exports = {
  generatePix,
  PixNaoConfiguradoError,
  PIX_NOT_CONFIGURED,
  MENSAGEM_PIX_NAO_CONFIGURADO,
};
