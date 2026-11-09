// ============================================================
// AURA. — Taxa da maquininha (17/08/2026; extraida de routes/pdv.js em 09/11/2026)
//
// Mora aqui para o "Editar venda" (services/editarVenda.js) recalcular a taxa
// com a MESMA regra da venda no Caixa. Nenhuma mudanca de comportamento: o
// texto abaixo e o que estava em routes/pdv.js.
// ============================================================
'use strict';

const fmt = (v) => parseFloat(v || 0).toFixed(2);
const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

// ── Taxa da maquininha (17/08/2026) ──────────────────────────
// Toggle em Configuracoes > PDV (vale pro Shell Negocio e pro Studio).
// Ligado, toda venda no cartao gera a despesa sozinha.
//
// Base = soma dos sale_payments no cartao, cada um na SUA aliquota:
// 'cartao' e CREDITO nos dois shells, 'debito' e separado. Dinheiro e
// crediario nao geram taxa.
//
// Pix pela maquininha (09/11/2026, decisao do Caio, Aura-backend#974): a venda
// nao sabe se o Pix passou pela maquininha ou caiu direto na chave da loja. Por
// isso a regra e por empresa: card_fee_pix_pct > 0 => TODO pagamento 'pix' paga
// a taxa, sem pergunta no Caixa. Ausente ou 0 => Pix sem taxa (o de sempre).
// So percentual. Na venda dividida incide so sobre a parte paga no Pix.
// Mesma categoria 'Taxas de cartao' e mesma chave pdv-card-fee-<id>.
//
// A receita bruta fica INTACTA: a taxa e uma despesa separada, nunca um
// abatimento da receita. Lancada na COMPETENCIA da venda (status
// 'confirmed'), nao na data do repasse da adquirente.
//
// Fora de escopo por decisao: taxa por parcelamento e conciliacao de repasse.
const CARD_FEE_KEY = (saleId) => 'pdv-card-fee-' + saleId;

async function insertCardFeeExpense(client, { companyId, saleId, cardBase, createdBy, saleDate, itemsSummary }) {
  const credBase = parseFloat((cardBase?.cartao || 0).toFixed(2));
  const debBase  = parseFloat((cardBase?.debito || 0).toFixed(2));
  const pixBase  = parseFloat((cardBase?.pix || 0).toFixed(2));
  if (credBase <= 0 && debBase <= 0 && pixBase <= 0) return null;

  let settings = null;
  try {
    const { rows } = await client.query(`SELECT pdv_settings FROM companies WHERE id = $1`, [companyId]);
    settings = rows[0]?.pdv_settings || null;
  } catch (e) {
    // Empresa/coluna indisponivel: a venda NAO pode cair por causa da taxa.
    console.warn('[PDV] card fee fail-open:', e.message);
    return null;
  }
  if (!settings?.card_fee_enabled) return null;

  const clampPct = (v) => Math.min(Math.max(parseFloat(v) || 0, 0), 100);
  const creditPct = clampPct(settings.card_fee_credit_pct);
  const debitPct  = clampPct(settings.card_fee_debit_pct);
  const pixPct    = clampPct(settings.card_fee_pix_pct);

  const fee = parseFloat((
    credBase * creditPct / 100 + debBase * debitPct / 100 + pixBase * pixPct / 100
  ).toFixed(2));
  if (fee <= 0) return null;

  const parts = [];
  if (credBase > 0 && creditPct > 0) parts.push(`credito ${fmt(credBase)} x ${creditPct}%`);
  if (debBase  > 0 && debitPct  > 0) parts.push(`debito ${fmt(debBase)} x ${debitPct}%`);
  if (pixBase  > 0 && pixPct    > 0) parts.push(`pix ${fmt(pixBase)} x ${pixPct}%`);

  const dueExpr = saleDate ? `$6::date` : SP_DATE_NOW;
  const params = [
    companyId, fee,
    `Taxa da maquininha - ${itemsSummary || 'Venda'} (${parts.join(' + ')})`,
    createdBy || null, CARD_FEE_KEY(saleId),
  ];
  if (saleDate) params.push(saleDate);

  await client.query(
    `INSERT INTO transactions
       (company_id,type,status,amount,description,category,due_date,paid_at,created_by,idempotency_key)
     VALUES ($1,'expense','confirmed',$2,$3,'Taxas de cartão',${dueExpr},NOW(),$4,$5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    params
  );
  const out = { fee, credit_pct: creditPct, debit_pct: debitPct, credit_base: credBase, debit_base: debBase };
  // Chaves do Pix so quando ele entrou na taxa: quem nao usa o Pix recebe o
  // mesmo objeto de antes.
  if (pixBase > 0 && pixPct > 0) { out.pix_pct = pixPct; out.pix_base = pixBase; }
  return out;
}

module.exports = { CARD_FEE_KEY, insertCardFeeExpense };
