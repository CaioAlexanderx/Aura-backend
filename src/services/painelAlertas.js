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
//   contato_sem_resposta     contato do WhatsApp da Aura sem resposta humana
//                            há mais de 2h, em horário comercial (8h–21h)
//
// `chave` identifica o alerta dentro do (dia, tipo): o id da loja, no
// pagamento sem loja o id do registro do webhook e, no contato, o id da
// conversa do hub.
// ============================================================
'use strict';

const b = require('./painelBlocos/_base');
const { REJEITADA } = require('./painelBlocos/fiscal');
const plantao = require('./plantao');
const cw = require('./contatosWhatsapp');

const DIAS_SEM_VENDA = 14;
// Pagamento sem loja segue avisando por este tempo; depois vira histórico.
const JANELA_SEM_LOJA_DIAS = 30;
// Contato do WhatsApp: avisa depois de 2h sem resposta humana e para de
// avisar com 3 dias (a partir daí o contato está na lista do bloco, não é
// mais um alerta). Teto de avisos por vez, para uma fila antiga não inundar.
const CONTATO_ESPERA_MIN = 2 * 60;
const CONTATO_JANELA_DIAS = 3;
const CONTATO_MAX_ALERTAS = 10;

function quandoVence(dia, hoje) {
  const d = b.diasEntre(hoje, dia);
  return d <= 0 ? 'vence hoje' : d === 1 ? 'vence amanhã' : `vence em ${d} dias`;
}

// Contatos do WhatsApp da Aura esperando resposta humana. Só avisa em
// horário comercial: de noite a Aurinha está de plantão e o resumo das 8h
// cobre o que chegou. O limite de 21h é a mesma fronteira do plantão
// (21:00 já é noite; 08:00 já é dia).
async function alertasDeContatos({ db = b.pool, agora = new Date() } = {}) {
  if (!cw.auraCompanyId()) return [];
  if (plantao.emHorarioNoturno(agora, null)) return [];

  const desde = new Date(agora.getTime() - (CONTATO_JANELA_DIAS + 1) * 86400000);
  const { contatos } = await cw.carregarContatos({ db, desde, ate: new Date(agora.getTime() + 1) });

  return contatos
    .filter((c) => c.pendente_desde
      && agora.getTime() - c.pendente_desde.getTime() > CONTATO_ESPERA_MIN * 60000
      && agora.getTime() - c.pendente_desde.getTime() <= CONTATO_JANELA_DIAS * 86400000)
    .sort((x, y) => x.pendente_desde - y.pendente_desde)
    .slice(0, CONTATO_MAX_ALERTAS)
    .map((c) => {
      const minutos = (agora.getTime() - c.pendente_desde.getTime()) / 60000;
      const telefone = cw.formatarTelefone(c.telefone);
      return {
        tipo: 'contato_sem_resposta',
        chave: c.conversa_id,
        company_id: c.empresa ? c.empresa.company_id : null,
        titulo: `${c.nome || (c.empresa && c.empresa.nome) || telefone || 'Contato'} sem resposta há ${cw.duracao(minutos)}`,
        detalhe: `WhatsApp ${telefone} · ${cw.linkWhatsapp(c.telefone)}${c.resposta_aurinha_em ? ' · Aurinha já respondeu' : ''}`,
        verbo: 'Responder',
        bloco: 'contatos',
      };
    });
}

async function calcularAlertas({ hoje, db = b.pool, empresas, agora = new Date() } = {}) {
  const emp = empresas || await b.carregarEmpresas(db);
  const alertas = [];

  const [ultima, semLoja, rejeitadas, contatos] = await Promise.all([
    b.ultimaVendaPorLoja(db),
    b.opcional(
      db,
      `SELECT DISTINCT ON (COALESCE(${b.PAGAMENTO_ASAAS}->>'id', id::text))
              id, processed_at, NULLIF(${b.PAGAMENTO_ASAAS}->>'value', '')::numeric AS valor
         FROM webhook_logs
        WHERE provider = 'asaas' AND event IN ${b.EVENTOS_PAGOS} AND company_id IS NULL
          AND processed_at >= ${b.desde(JANELA_SEM_LOJA_DIAS)}
        ORDER BY COALESCE(${b.PAGAMENTO_ASAAS}->>'id', id::text), processed_at`,
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
    // O hub é uma fonte a mais: se ela falhar, os outros alertas saem.
    alertasDeContatos({ db, agora }).catch((err) => {
      console.error('[painel] alerta de contatos falhou:', err.message);
      return [];
    }),
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

  // 3. Pagamento recebido na Asaas sem loja vinculada (um por cobrança; some
  //    quando alguém vincula em /admin/painel/asaas/orfaos).
  semLoja.sort((x, y) => new Date(y.processed_at) - new Date(x.processed_at));
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

  // 5. Contato do WhatsApp da Aura sem resposta humana (mais antigo primeiro).
  alertas.push(...contatos);

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

module.exports = {
  calcularAlertas, gravarAlertas, alertasDeContatos,
  DIAS_SEM_VENDA, JANELA_SEM_LOJA_DIAS,
  CONTATO_ESPERA_MIN, CONTATO_JANELA_DIAS,
};
