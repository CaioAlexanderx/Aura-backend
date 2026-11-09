// ============================================================
// AURA. -- Endereco de entrega da venda do Caixa (09/11/2026, parte 2)
//
// Regra do Caio: "No caso de venda com frete, sempre pedir endereco do
// cliente (caso nao possua)." O app trava o "Concluir venda" e pede o
// endereco antes do pagamento; aqui o servidor:
//
//   1. tira o RETRATO do endereco no momento da venda e grava em
//      sales.delivery_address (migration 435). O papel de entrega
//      reimpresso depois sai igual, mesmo se o cadastro mudar;
//   2. guarda o endereco no cadastro do cliente quando ele ainda nao tem
//      um endereco de entrega (nunca sobrescreve um que ja existe);
//   3. responde 422 DELIVERY_ADDRESS_REQUIRED quando a venda tem frete e
//      falta o minimo: nome, rua ou CEP, numero e cidade.
//
// Venda com frete = uma linha SEM produto chamada "Frete" com valor > 0.
// E assim que o Caixa manda o frete desde 30/10 (app utils/frete.ts).
//
// COMPATIBILIDADE COM O APP ANTIGO (decisao): a trava 3 so vale quando o
// app manda `delivery_check: true`. Quem esta com o bundle de antes no
// meio de uma venda com frete nao recebe o endereco na tela e nao teria
// como responder ao 422: a venda cairia no balcao. Sem a flag a venda
// segue como sempre (o retrato ainda e gravado se o cliente ja tiver
// endereco). Quando todo mundo estiver no bundle novo, a flag pode virar
// o padrao aqui sem mudar o app.
//
// Body (todos opcionais):
//   delivery_check: true            -- app que conhece a trava
//   delivery_address: {             -- o que a tela "Para onde vai a
//     name, phone,                  --   entrega?" / "Quem recebe a
//     zip_code, street, number,     --   entrega?" juntou
//     complement, neighborhood, city, state, address_reference,
//     note                          -- recado para a entrega
//   }
// O endereco tambem pode vir no cliente inline (body.customer), o mesmo
// que o resolveInlineCustomer usa para cadastrar quem ainda nao existe.
//
// Fonte do endereco, nesta ordem: delivery_address > body.customer >
// cadastro do cliente. Nome e telefone: delivery_address > cadastro >
// body.customer.
//
// Nunca derruba a venda por conta propria: leitura e gravacao rodam em
// SAVEPOINT e, se falharem (coluna ausente, erro qualquer), a venda segue
// sem o retrato. O unico bloqueio e o 422 da trava.
// ============================================================
'use strict';

const { ADDRESS_FIELDS, parseCustomerAddress, hasDeliveryAddress } = require('./customerAddress');

const NOME_DO_FRETE = 'frete';
const MAX = { name: 120, phone: 30, note: 300 };

// null = ainda nao sabemos; false = 42703 visto (migration 435 ausente).
let colunaDaVenda = null;
function _resetCache() { colunaDaVenda = null; }

function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Soma das linhas "Frete" (sem produto) da venda. */
function valorDoFrete(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    if (!it || it.product_id) continue;
    const nome = texto(it.product_name_snapshot || it.product_name).toLowerCase();
    if (nome !== NOME_DO_FRETE) continue;
    const linha = (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
    if (linha > 0) total += linha;
  }
  return Math.round(total * 100) / 100;
}

const temFrete = (items) => valorDoFrete(items) > 0;

/** O que falta para levar uma entrega. Mesmo criterio de
 *  customerAddress.hasDeliveryAddress, mais o nome de quem recebe. */
function faltandoParaEntrega(r) {
  const falta = [];
  if (!texto(r && r.name)) falta.push('name');
  if (!texto(r && r.street) && !texto(r && r.zip_code)) falta.push('street');
  if (!texto(r && r.number)) falta.push('number');
  if (!texto(r && r.city)) falta.push('city');
  return falta;
}

function temAlgumEndereco(v) {
  return !!v && ['zip_code', 'street', 'number', 'city'].some((k) => texto(v[k]));
}

/** Le um bloco de endereco (delivery_address ou customer). */
function lerBloco(raw, campo) {
  if (!raw || typeof raw !== 'object') return { ok: true, endereco: null, name: '', phone: '', note: '' };
  const addr = parseCustomerAddress(raw);
  if (!addr.ok) return { ok: false, erro: { error: addr.error, field: addr.field, code: 'INVALID_DELIVERY_ADDRESS' } };
  for (const k of ['name', 'phone', 'note']) {
    if (texto(raw[k]).length > MAX[k]) {
      const rotulo = { name: 'Nome', phone: 'Telefone', note: 'Recado' }[k];
      return { ok: false, erro: { error: `${rotulo} passou de ${MAX[k]} letras`, field: k, code: 'INVALID_DELIVERY_ADDRESS' } };
    }
  }
  const values = addr.values;
  return {
    ok: true,
    endereco: temAlgumEndereco(values) ? values : null,
    name: texto(raw.name),
    phone: texto(raw.phone),
    note: campo === 'delivery_address' ? texto(raw.note) : '',
  };
}

async function comSavepoint(client, nome, fn) {
  await client.query(`SAVEPOINT ${nome}`);
  try {
    const r = await fn();
    await client.query(`RELEASE SAVEPOINT ${nome}`);
    return r;
  } catch (e) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${nome}`); } catch (_) { /* nada */ }
    throw e;
  }
}

const COLUNAS_DO_CLIENTE = 'name, phone, zip_code, street, number, complement, neighborhood, city, state';

async function lerCliente(client, customerId) {
  try {
    return await comSavepoint(client, 'entrega_cliente', async () => {
      const { rows } = await client.query(
        `SELECT ${COLUNAS_DO_CLIENTE}, address_reference FROM customers WHERE id = $1`, [customerId]
      );
      return rows[0] || null;
    });
  } catch (e) {
    if (e.code !== '42703') throw e;
    // Sem a 433: le sem o ponto de referencia.
    return comSavepoint(client, 'entrega_cliente', async () => {
      const { rows } = await client.query(`SELECT ${COLUNAS_DO_CLIENTE} FROM customers WHERE id = $1`, [customerId]);
      return rows[0] || null;
    });
  }
}

/** Retrato no formato da migration 435: todas as chaves, texto ('' = vazio). */
function montarRetrato({ endereco, name, phone, note }) {
  const out = { name: texto(name), phone: texto(phone) };
  for (const k of ADDRESS_FIELDS) out[k] = texto(endereco && endereco[k]);
  out.note = texto(note);
  return out;
}

/**
 * Antes do INSERT da venda, depois de resolver o cliente. Sem frete e sem
 * delivery_address devolve null e nao toca o banco (venda de sempre).
 *
 * @returns {null
 *   | { erro: { error, code, field?, missing? } }
 *   | { retrato: object|null, preencherCliente: object|null }}
 */
async function prepararEntrega(client, { customerId, body, items }) {
  const b = body || {};
  const frete = temFrete(items);
  const pediu = b.delivery_address && typeof b.delivery_address === 'object';
  if (!frete && !pediu) return null;

  const daVenda = lerBloco(b.delivery_address, 'delivery_address');
  if (!daVenda.ok) return { erro: daVenda.erro };
  const doInline = lerBloco(b.customer, 'customer');
  if (!doInline.ok) return { erro: doInline.erro };

  let cliente = null;
  if (customerId) {
    try {
      cliente = await lerCliente(client, customerId);
    } catch (e) {
      // Nao deu para ler o cadastro: segue sem retrato e sem trava (a venda
      // nao pode cair por isso).
      console.warn('[entrega] leitura do cliente falhou, venda segue:', e.message);
      return null;
    }
  }

  const doBody = daVenda.endereco || doInline.endereco;
  const retrato = montarRetrato({
    endereco: doBody || cliente,
    name: daVenda.name || (cliente && cliente.name) || doInline.name,
    phone: daVenda.phone || (cliente && cliente.phone) || doInline.phone,
    note: daVenda.note,
  });

  if (frete && b.delivery_check === true) {
    const missing = faltandoParaEntrega(retrato);
    if (missing.length) {
      return {
        erro: {
          error: 'Venda com frete precisa do endereço de entrega: nome, rua ou CEP, número e cidade.',
          code: 'DELIVERY_ADDRESS_REQUIRED',
          missing,
        },
      };
    }
  }

  // Endereco novo vai para o cadastro de quem ainda nao tem um completo.
  const preencherCliente = (customerId && cliente && doBody && !hasDeliveryAddress(cliente))
    ? doBody : null;

  return { retrato: temAlgumEndereco(retrato) ? retrato : null, preencherCliente };
}

/**
 * Depois do INSERT da venda, dentro da mesma transacao. Fail-open: erro
 * aqui vira aviso no log e a venda segue.
 * @returns {object|null} o retrato gravado (para a resposta do POST)
 */
async function gravarEntrega(client, { companyId, saleId, customerId, entrega }) {
  if (!entrega) return null;
  let gravado = null;

  if (entrega.retrato && colunaDaVenda !== false) {
    try {
      await comSavepoint(client, 'entrega_venda', () => client.query(
        `UPDATE sales SET delivery_address = $1::jsonb WHERE id = $2 AND company_id = $3`,
        [JSON.stringify(entrega.retrato), saleId, companyId]
      ));
      colunaDaVenda = true;
      gravado = entrega.retrato;
    } catch (e) {
      if (e.code === '42703') colunaDaVenda = false; // migration 435 ainda nao aplicada
      else console.warn('[entrega] retrato da venda nao gravou, venda segue:', e.message);
    }
  }

  if (entrega.preencherCliente && customerId) {
    const sets = Object.entries(entrega.preencherCliente).filter(([, v]) => v !== undefined);
    const gravar = async (cols) => {
      if (!cols.length) return;
      await comSavepoint(client, 'entrega_cadastro', () => client.query(
        `UPDATE customers SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW()
          WHERE id = $1`,
        [customerId, ...cols.map(([, v]) => v)]
      ));
    };
    try {
      try {
        await gravar(sets);
      } catch (e) {
        if (e.code !== '42703') throw e;
        // Sem a 433 (address_reference): grava o resto.
        await gravar(sets.filter(([k]) => k !== 'address_reference'));
      }
    } catch (e) {
      console.warn('[entrega] endereco do cadastro nao gravou, venda segue:', e.message);
    }
  }

  return gravado;
}

module.exports = {
  valorDoFrete,
  temFrete,
  faltandoParaEntrega,
  montarRetrato,
  prepararEntrega,
  gravarEntrega,
  _resetCache,
};
