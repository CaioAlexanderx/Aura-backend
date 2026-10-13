// ============================================================
// AURA. — Painel da Gestão Aura: alertas derivados
//
// Calculados no mesmo passo dos blocos (services/painelDiario.js). Cada
// alerta aponta para uma loja e para o bloco onde o assunto se resolve:
//
//   pagante_anual_vencendo   anual que vence em até 2 dias, sem venda há 14+
//   trial_com_venda_vencendo trial que já vendeu e vence em 48h
//   pagamento_sem_loja       pagamento da Asaas sem loja vinculada
//   nfce_rejeitada           NFC-e rejeitada nos últimos 7 dias
//
// `chave` identifica o alerta dentro do (dia, tipo): o id da loja ou, no
// pagamento sem loja, o id do registro do webhook.
// ============================================================
'use strict';

const b = require('./painelBlocos/_base');
const { REJEITADA } = require('./painelBlocos/fiscal');

const DIAS_SEM_VENDA = 14;
// Pagamento sem loja segue avisando por este tempo; depois vira histórico.
const JANELA_SEM_LOJA_DIAS = 30;

function quandoVence(dia, hoje) {
  const d = b.diasEntre(hoje, dia);
  return d <= 0 ? 'vence hoje' : d === 1 ? 'vence amanhã' : `vence em ${d} dias`;
}

async function calcularAlertas({ hoje, db = b.pool, empresas } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const alertas = [];

  const [ultima, semLoja, rejeitadas] = await Promise.all([
    b.ultimaVendaPorLoja(db),
    b.opcional(
      db,
      `SELECT id, processed_at, NULLIF(payload->'payment'->>'value', '')::numeric AS valor
         FROM webhook_logs
        WHERE provider = 'asaas' AND event = 'PAYMENT_RECEIVED' AND company_id IS NULL
          AND processed_at >= ${b.desde(JANELA_SEM_LOJA_DIAS)}
        ORDER BY processed_at DESC`,
      [hoje]
    ),
    b.opcional(
      db,
      `SELECT company_id, COUNT(*) AS rejeitadas,
              (ARRAY_AGG(COALESCE(NULLIF(last_error, ''), NULLIF(error_message, ''), rejection_code) ORDER BY created_at DESC))[1] AS motivo
         FROM nfce_emissions
        WHERE status IN ${REJEITADA} AND created_at >= ${b.desde(7)}
        GROUP BY company_id`,
      [hoje]
    ),
  ]);

  // 1. Pagante anual que vence em até 2 dias sem vender há 14+ dias.
  for (const e of emp.pagantes) {
    if (e.ciclo !== 'annual' || !e.vence_em) continue;
    const faltam = b.diasEntre(hoje, e.vence_em);
    if (faltam < 0 || faltam > 2) continue;
    const v = ultima.get(e.company_id);
    const semVenda = v ? b.diasEntre(b.diaDe(v.ultima), hoje) : null;
    if (semVenda !== null && semVenda < DIAS_SEM_VENDA) continue;
    alertas.push({
      tipo: 'pagante_anual_vencendo',
      chave: e.company_id,
      company_id: e.company_id,
      titulo: `${e.nome} ${quandoVence(e.vence_em, hoje)}`,
      detalhe: `Anual · ${semVenda === null ? 'nunca vendeu' : `sem venda há ${semVenda} dias`}`,
      verbo: 'Ligar',
      bloco: 'pagantes_sem_venda',
    });
  }

  // 2. Trial que já vendeu e vence em 48h.
  for (const e of emp.lista) {
    if (e.pagante || e.eh_dojo || !e.trial_ate) continue;
    const faltam = b.diasEntre(hoje, e.trial_ate);
    if (faltam < 0 || faltam > 2) continue;
    const v = ultima.get(e.company_id);
    if (!v || !v.vendas) continue;
    alertas.push({
      tipo: 'trial_com_venda_vencendo',
      chave: e.company_id,
      company_id: e.company_id,
      titulo: `${e.nome}: trial com venda ${quandoVence(e.trial_ate, hoje)}`,
      detalhe: `${b.plural(v.vendas, 'venda', 'vendas')} no trial`,
      verbo: 'Oferecer',
      bloco: 'trials_degrau',
    });
  }

  // 3. Pagamento recebido na Asaas sem loja vinculada.
  for (const p of semLoja) {
    alertas.push({
      tipo: 'pagamento_sem_loja',
      chave: String(p.id),
      company_id: null,
      titulo: `${p.valor === null || p.valor === undefined ? 'Pagamento' : b.brl(p.valor)} recebido sem loja vinculada`,
      detalhe: `Asaas · ${b.rotuloDia(b.diaDe(p.processed_at))}`,
      verbo: 'Vincular',
      bloco: 'receita',
    });
  }

  // 4. NFC-e rejeitada em 7 dias.
  for (const r of rejeitadas) {
    const e = emp.porId.get(r.company_id);
    if (!e) continue;
    alertas.push({
      tipo: 'nfce_rejeitada',
      chave: e.company_id,
      company_id: e.company_id,
      titulo: `${e.nome}: ${b.plural(b.num(r.rejeitadas), 'NFC-e rejeitada', 'NFC-e rejeitadas')} em 7 dias`,
      detalhe: r.motivo ? String(r.motivo).slice(0, 200) : null,
      verbo: 'Ver',
      bloco: 'fiscal',
    });
  }

  return alertas;
}

// Troca os alertas do dia pelos calculados agora.
async function gravarAlertas({ hoje, db = b.pool, alertas }) {
  await db.query(
    `DELETE FROM painel_alertas
      WHERE dia = $1::date AND NOT ((tipo || ':' || chave) = ANY($2::text[]))`,
    [hoje, alertas.map((a) => `${a.tipo}:${a.chave}`)]
  );
  if (!alertas.length) return;
  await db.query(
    `INSERT INTO painel_alertas (dia, tipo, chave, company_id, titulo, detalhe, verbo, bloco)
     SELECT $1::date, x.tipo, x.chave, x.company_id, x.titulo, x.detalhe, x.verbo, x.bloco
       FROM jsonb_to_recordset($2::jsonb) AS x(
         tipo text, chave text, company_id uuid, titulo text, detalhe text, verbo text, bloco text)
     ON CONFLICT (dia, tipo, chave) DO UPDATE SET
       company_id = EXCLUDED.company_id,
       titulo = EXCLUDED.titulo,
       detalhe = EXCLUDED.detalhe,
       verbo = EXCLUDED.verbo,
       bloco = EXCLUDED.bloco`,
    [hoje, JSON.stringify(alertas)]
  );
}

module.exports = { calcularAlertas, gravarAlertas, DIAS_SEM_VENDA, JANELA_SEM_LOJA_DIAS };
