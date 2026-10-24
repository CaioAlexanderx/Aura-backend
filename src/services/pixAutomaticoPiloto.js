// ============================================================
// AURA. — Piloto do Pix Automático: migração de uma empresa (tq-105)
//
// Usado pela rota de staff (routes/adminPainelPixAutomatico.js).
//
// iniciarAutorizacao — cria a autorização (Jornada 3, SUBSCRIPTION) e
//   devolve o QR e o copia e cola para a Cassie mandar à cliente. NÃO mexe
//   na assinatura Pix comum: até a autorização ficar active, a cliente segue
//   pagando como sempre.
//
//   Datas padrão (dá para mandar outras no corpo):
//     - valor: o da assinatura Pix comum atual (GET /subscriptions/:id);
//     - o QR paga o ciclo do próximo vencimento da assinatura antiga
//       (nextDueDate); o primeiro débito automático (startDate) é um mês
//       depois dele;
//     - data_fim: só se vier no corpo, ou derivada de cobrancas_restantes
//       (o anual para na 12ª cobrança: a staff informa quantas faltam).
//
//   Trava contra duas autorizações: pix_auto_status vai para 'creating' num
//   UPDATE condicional antes de chamar a Asaas (só entra quem acha a empresa
//   sem autorização viva); o índice único parcial da migration 406 é a
//   segunda trava. Se a Asaas falhar, o status volta ao que era.
//
// trocarAssinatura — só com a autorização active no banco E na Asaas (GET
//   na hora). Cancela a assinatura Pix comum antiga e as cobranças pendentes
//   dela (o QR já pagou aquele ciclo) e aponta companies.asaas_subscription_id
//   para a assinatura que a Asaas criou com a autorização. Nunca há dois
//   débitos: antes de active nada é cancelado; sem a assinatura nova, nada
//   é cancelado.
//
// MULTI-CNPJ: a cobrança é da empresa que paga (billing_owner_company_id
// nulo ou ela mesma). Filial de grupo é recusada com o id da principal.
// ============================================================
'use strict';

const VIVOS = new Set(['pending', 'active']);
const FINAIS = new Set(['refused', 'cancelled', 'expired']);
const STATUS_DA_ASAAS = {
  CREATED: 'pending', ACTIVE: 'active', REFUSED: 'refused', CANCELLED: 'cancelled', EXPIRED: 'expired',
};

function erro(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function erroDaAsaas(err, oQue) {
  if (err && err.status && !err.asaasStatus && !err.asaasTimeout) return err;
  return erro(502, 'asaas_falhou', `A Asaas recusou ou não respondeu ao ${oQue}: ${err && err.message}`, {
    asaas_status: (err && err.asaasStatus) || null,
  });
}

function hojeBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

/** AAAA-MM-DD + n meses, prendendo no último dia do mês (31/01 + 1 → 28/02). */
function somarMeses(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

function contractIdPara(companyId, now = Date.now()) {
  // 4 + 12 + até 9 = no máximo 25 (limite da Asaas: 35). Muda a cada
  // tentativa: uma autorização recusada não bloqueia a próxima.
  return 'AURA' + String(companyId).replace(/-/g, '').slice(0, 12) + now.toString(36);
}

async function carregarEmpresa(db, companyId) {
  const r = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS nome, asaas_customer_id, asaas_subscription_id,
            pix_auto_status, asaas_pix_auto_authorization_id, billing_owner_company_id, billing_cycle
       FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!r.rows.length) throw erro(404, 'empresa_nao_encontrada', 'Empresa não encontrada');
  return r.rows[0];
}

async function auditar(db, { userId, companyId, action, payload }) {
  await db.query(
    `INSERT INTO admin_audit_log (staff_user_id, company_id, action, payload, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, companyId, action, JSON.stringify(payload || {}), 'piloto Pix Automático']
  ).catch((e) => console.error('[pixAutomatico] auditoria falhou (seguindo): ' + e.message));
}

// pending/active no banco: confirma na Asaas. Se lá já acabou (o evento não
// chegou — webhook sem os eventos assinados, por exemplo), sincroniza e
// libera uma nova. Se segue viva, recusa.
async function conferirAutorizacaoViva({ db, cliente, empresa }) {
  if (!VIVOS.has(empresa.pix_auto_status) || !empresa.asaas_pix_auto_authorization_id) return;
  let real;
  try {
    real = await cliente.consultarAutorizacao(empresa.asaas_pix_auto_authorization_id);
  } catch (err) {
    throw erro(409, 'ja_tem_autorizacao',
      'A empresa já tem uma autorização em andamento e a Asaas não respondeu para conferir.',
      { authorization_id: empresa.asaas_pix_auto_authorization_id, pix_auto_status: empresa.pix_auto_status });
  }
  const statusReal = STATUS_DA_ASAAS[real && real.status];
  if (!FINAIS.has(statusReal)) {
    throw erro(409, 'ja_tem_autorizacao',
      'A empresa já tem uma autorização ' + (statusReal === 'active' ? 'ativa' : 'esperando o pagamento do QR') +
      '. Para reenviar o QR, consulte GET /admin/painel/pix-automatico/' + empresa.id + '.',
      { authorization_id: empresa.asaas_pix_auto_authorization_id, pix_auto_status: statusReal || empresa.pix_auto_status });
  }
  await db.query(
    `UPDATE companies SET pix_auto_status = $1, updated_at = NOW()
      WHERE id = $2 AND asaas_pix_auto_authorization_id = $3`,
    [statusReal, empresa.id, empresa.asaas_pix_auto_authorization_id]
  );
  await db.query(
    `UPDATE pix_automatico_autorizacoes SET status = $2, updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'active')`,
    [empresa.asaas_pix_auto_authorization_id, statusReal]
  ).catch((e) => { if (e.code !== '42P01') throw e; });
  empresa.pix_auto_status = statusReal;
}

async function resolverPlano({ cliente, empresa, body }) {
  const b = body || {};
  let valor = b.valor != null ? Number(b.valor) : null;
  let primeiroDebito = b.primeiro_debito || null;
  let cicloDoQr = null;
  if (valor == null || !primeiroDebito) {
    if (!empresa.asaas_subscription_id) {
      throw erro(400, 'sem_assinatura_atual',
        'A empresa não tem assinatura na Asaas: informe valor e primeiro_debito.');
    }
    let sub;
    try {
      sub = await cliente.consultarAssinatura(empresa.asaas_subscription_id);
    } catch (err) {
      throw erroDaAsaas(err, 'consultar a assinatura atual');
    }
    if (valor == null) valor = Number(sub && sub.value);
    if (!primeiroDebito) {
      if (!sub || !sub.nextDueDate) {
        throw erro(400, 'sem_proximo_vencimento', 'A assinatura atual não tem próximo vencimento: informe primeiro_debito.');
      }
      cicloDoQr = String(sub.nextDueDate).slice(0, 10);
      primeiroDebito = somarMeses(cicloDoQr, 1);
    }
  }
  let dataFim = b.data_fim || null;
  if (!dataFim && b.cobrancas_restantes != null) {
    const n = Math.floor(Number(b.cobrancas_restantes));
    if (!Number.isFinite(n) || n < 1) throw erro(400, 'cobrancas_restantes_invalido', 'cobrancas_restantes precisa ser 1 ou mais');
    dataFim = somarMeses(primeiroDebito, n - 1);
  }
  if (String(primeiroDebito).slice(0, 10) <= hojeBrt()) {
    throw erro(400, 'primeiro_debito_no_passado', 'O primeiro débito automático precisa ser depois de hoje.');
  }
  return {
    valor,
    primeiroDebito: String(primeiroDebito).slice(0, 10),
    dataFim,
    cicloDoQr,
    valorPrimeiroPagamento: b.valor_primeiro_pagamento != null ? Number(b.valor_primeiro_pagamento) : valor,
    expiracaoSegundos: b.expiracao_segundos != null ? Number(b.expiracao_segundos) : undefined,
  };
}

async function iniciarAutorizacao({ db, cliente, companyId, userId, body }) {
  const empresa = await carregarEmpresa(db, companyId);
  if (empresa.billing_owner_company_id && empresa.billing_owner_company_id !== empresa.id) {
    throw erro(409, 'cobranca_na_principal',
      'A cobrança desta empresa é feita na empresa principal do grupo. Inicie pela principal.',
      { billing_owner_company_id: empresa.billing_owner_company_id });
  }
  if (!empresa.asaas_customer_id) {
    throw erro(409, 'sem_cliente_asaas', 'A empresa não tem cliente na Asaas (asaas_customer_id).');
  }
  await conferirAutorizacaoViva({ db, cliente, empresa });

  const plano = await resolverPlano({ cliente, empresa, body });

  // Trava: só uma criação por vez e nunca por cima de autorização viva.
  // 'creating' parado há mais de 10 min (processo caiu no meio) é liberado.
  const anterior = empresa.pix_auto_status || null;
  const trava = await db.query(
    `UPDATE companies
        SET pix_auto_status = 'creating', updated_at = NOW()
      WHERE id = $1
        AND (pix_auto_status IS NULL
             OR pix_auto_status IN ('refused', 'cancelled', 'expired')
             OR (pix_auto_status = 'creating' AND updated_at < NOW() - INTERVAL '10 minutes'))
      RETURNING id`,
    [empresa.id]
  );
  if (!trava.rows.length) {
    throw erro(409, 'ja_tem_autorizacao', 'Já existe uma autorização sendo criada ou em andamento para esta empresa.');
  }
  const soltar = () => db.query(
    `UPDATE companies SET pix_auto_status = $2, updated_at = NOW()
      WHERE id = $1 AND pix_auto_status = 'creating'`,
    [empresa.id, anterior]
  ).catch((e) => console.error('[pixAutomatico] falha ao soltar a trava da company ' + empresa.id + ': ' + e.message));

  const desligarNotificacoes = !(body && body.manter_notificacoes_asaas === true);
  const contractId = contractIdPara(empresa.id);
  let autorizacao;
  let corpo;
  try {
    if (desligarNotificacoes) {
      try {
        await cliente.desligarNotificacoesDoCliente(empresa.asaas_customer_id);
      } catch (err) {
        throw erroDaAsaas(err, 'desligar as notificações do cliente');
      }
    }
    try {
      ({ autorizacao, corpo } = await cliente.criarAutorizacao({
        customerId: empresa.asaas_customer_id,
        valor: plano.valor,
        primeiroDebito: plano.primeiroDebito,
        dataFim: plano.dataFim,
        contractId,
        descricao: 'Assinatura Aura',
        valorPrimeiroPagamento: plano.valorPrimeiroPagamento,
        expiracaoSegundos: plano.expiracaoSegundos,
      }));
    } catch (err) {
      throw erroDaAsaas(err, 'criar a autorização');
    }
    if (!autorizacao || !autorizacao.id) throw erro(502, 'asaas_sem_id', 'A Asaas não devolveu o id da autorização.');
  } catch (err) {
    await soltar();
    throw err;
  }

  const status = STATUS_DA_ASAAS[autorizacao.status] || 'pending';
  try {
    await db.query(
      `UPDATE companies
          SET pix_auto_status = $2, asaas_pix_auto_authorization_id = $3, updated_at = NOW()
        WHERE id = $1`,
      [empresa.id, status, autorizacao.id]
    );
  } catch (err) {
    // A autorização existe na Asaas e o banco não guardou: log alto com o id
    // para cancelar à mão (DELETE /pix/automatic/authorizations/:id).
    console.error(`[pixAutomatico] AUTORIZAÇÃO SEM DONO: ${autorizacao.id} criada para a company ${empresa.id}` +
      ` e não gravada (${err.message}). Cancele na Asaas ou grave à mão.`);
    throw erro(500, 'falha_ao_gravar', 'A autorização foi criada na Asaas mas não foi gravada. Avise a Tecnologia.',
      { authorization_id: autorizacao.id });
  }
  try {
    await db.query(
      `INSERT INTO pix_automatico_autorizacoes
         (id, company_id, status, contract_id, value, first_payment_value, start_date, finish_date,
          asaas_customer_id, subscription_id, old_subscription_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
      [autorizacao.id, empresa.id, status, corpo.contractId, corpo.value, corpo.immediateQrCode.originalValue,
        corpo.startDate, corpo.finishDate || null, empresa.asaas_customer_id, autorizacao.subscriptionId || null,
        empresa.asaas_subscription_id || null, userId || null]
    );
  } catch (err) {
    console.error('[pixAutomatico] linha de pix_automatico_autorizacoes não gravada (' + (err.code || '') + '): ' + err.message);
  }

  console.log(`[pixAutomatico] autorização ${autorizacao.id} criada para a company ${empresa.id} por ${userId || '?'}` +
    ` (primeiro débito ${corpo.startDate}${corpo.finishDate ? ', fim ' + corpo.finishDate : ''})`);
  await auditar(db, {
    userId, companyId: empresa.id, action: 'pix_automatico_autorizar',
    payload: { authorization_id: autorizacao.id, value: corpo.value, start_date: corpo.startDate,
      finish_date: corpo.finishDate || null, notificacoes_desligadas: desligarNotificacoes },
  });

  return {
    company: { id: empresa.id, nome: empresa.nome },
    authorization: cliente.resumoDaAutorizacao(autorizacao),
    pix_auto_status: status,
    plano: {
      valor: corpo.value,
      valor_primeiro_pagamento: corpo.immediateQrCode.originalValue,
      ciclo_pago_pelo_qr: plano.cicloDoQr,
      primeiro_debito: corpo.startDate,
      data_fim: corpo.finishDate || null,
    },
    notificacoes_asaas_desligadas: desligarNotificacoes,
    assinatura_antiga: empresa.asaas_subscription_id || null,
    aviso: 'A assinatura Pix comum continua ativa. Depois que a autorização ficar ativa, ' +
      'use POST /admin/painel/pix-automatico/' + empresa.id + '/trocar-assinatura.',
  };
}

const NAO_ENCONTRADO = (err) => err && err.asaasStatus === 404;

async function trocarAssinatura({ db, cliente, companyId, userId }) {
  const empresa = await carregarEmpresa(db, companyId);
  if (empresa.pix_auto_status !== 'active' || !empresa.asaas_pix_auto_authorization_id) {
    throw erro(409, 'autorizacao_nao_ativa',
      'A troca só acontece com a autorização do Pix Automático ativa. Status atual: ' + (empresa.pix_auto_status || 'nenhum') + '.',
      { pix_auto_status: empresa.pix_auto_status || null });
  }
  let real;
  try {
    real = await cliente.consultarAutorizacao(empresa.asaas_pix_auto_authorization_id);
  } catch (err) {
    throw erroDaAsaas(err, 'conferir a autorização');
  }
  if (!real || real.status !== 'ACTIVE') {
    throw erro(409, 'autorizacao_nao_ativa',
      'Na Asaas a autorização não está ativa (' + ((real && real.status) || 'sem status') + '). Nada foi cancelado.',
      { asaas_status: (real && real.status) || null });
  }

  let assinaturaNova = real.subscriptionId || null;
  if (!assinaturaNova) {
    try {
      const r = await db.query('SELECT subscription_id FROM pix_automatico_autorizacoes WHERE id = $1', [real.id]);
      assinaturaNova = (r.rows[0] && r.rows[0].subscription_id) || null;
    } catch (e) { if (e.code !== '42P01') throw e; }
  }
  if (!assinaturaNova) {
    throw erro(409, 'sem_assinatura_nova',
      'A autorização está ativa mas a Asaas não informou a assinatura nova. Nada foi cancelado.');
  }

  const antiga = empresa.asaas_subscription_id || null;
  if (antiga === assinaturaNova) {
    return { company: { id: empresa.id, nome: empresa.nome }, ja_trocada: true, assinatura: assinaturaNova };
  }

  let pendentes = [];
  const excluidas = [];
  const naoExcluidas = [];
  if (antiga) {
    try {
      pendentes = await cliente.listarCobrancasPendentesDaAssinatura(antiga);
    } catch (err) {
      throw erroDaAsaas(err, 'listar as cobranças pendentes da assinatura antiga');
    }
    // tq-73 (24/10/2026): a troca é da Aura — o SUBSCRIPTION_DELETED da
    // antiga não vira e-mail de "assinatura cancelada".
    await require('./assinaturasAsaas').marcarEncerramentoPedido(db, antiga, { companyId: empresa.id, motivo: 'pix_automatico' });
    try {
      await cliente.cancelarAssinatura(antiga);
    } catch (err) {
      if (!NAO_ENCONTRADO(err)) throw erroDaAsaas(err, 'cancelar a assinatura antiga');
    }
    // O QR do primeiro pagamento já pagou o ciclo; a cobrança pendente da
    // assinatura antiga seria o segundo débito. 404 = a Asaas já removeu
    // junto com a assinatura.
    for (const p of pendentes) {
      try {
        await cliente.excluirCobranca(p.id);
        excluidas.push({ id: p.id, due_date: p.dueDate || null, value: p.value != null ? Number(p.value) : null });
      } catch (err) {
        if (NAO_ENCONTRADO(err)) excluidas.push({ id: p.id, due_date: p.dueDate || null, ja_removida: true });
        else naoExcluidas.push({ id: p.id, due_date: p.dueDate || null, erro: err.message });
      }
    }
  }

  await db.query(
    `UPDATE companies SET asaas_subscription_id = $2, updated_at = NOW()
      WHERE id = $1 AND asaas_subscription_id IS NOT DISTINCT FROM $3`,
    [empresa.id, assinaturaNova, antiga]
  );
  await db.query(
    `UPDATE pix_automatico_autorizacoes
        SET swapped_at = COALESCE(swapped_at, NOW()), swapped_by = COALESCE(swapped_by, $2),
            old_subscription_id = COALESCE(old_subscription_id, $3),
            subscription_id = COALESCE(subscription_id, $4), updated_at = NOW()
      WHERE id = $1`,
    [real.id, userId || null, antiga, assinaturaNova]
  ).catch((e) => { if (e.code !== '42P01') console.error('[pixAutomatico] troca não registrada na autorização: ' + e.message); });

  console.log(`[pixAutomatico] troca de assinatura na company ${empresa.id}: ${antiga || '(nenhuma)'} -> ${assinaturaNova}` +
    ` (${excluidas.length} cobrança(s) pendente(s) removida(s), ${naoExcluidas.length} com falha) por ${userId || '?'}`);
  await auditar(db, {
    userId, companyId: empresa.id, action: 'pix_automatico_trocar_assinatura',
    payload: { authorization_id: real.id, assinatura_antiga: antiga, assinatura_nova: assinaturaNova,
      cobrancas_removidas: excluidas.map((x) => x.id), cobrancas_com_falha: naoExcluidas.map((x) => x.id) },
  });

  return {
    company: { id: empresa.id, nome: empresa.nome },
    ja_trocada: false,
    assinatura_antiga_cancelada: antiga,
    assinatura: assinaturaNova,
    cobrancas_pendentes_removidas: excluidas,
    cobrancas_nao_removidas: naoExcluidas,
    aviso: naoExcluidas.length
      ? 'Algumas cobranças pendentes da assinatura antiga não foram removidas: apague na Asaas para não haver cobrança dupla.'
      : null,
  };
}

async function estado({ db, cliente, companyId }) {
  const empresa = await carregarEmpresa(db, companyId);
  let historico = [];
  try {
    const r = await db.query(
      `SELECT id, status, value, start_date::text AS start_date, finish_date::text AS finish_date,
              subscription_id, old_subscription_id, created_at, activated_at, refused_at,
              cancelled_at, cancellation_reason, expired_at, swapped_at
         FROM pix_automatico_autorizacoes WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [empresa.id]
    );
    historico = r.rows;
  } catch (e) { if (e.code !== '42P01') throw e; }
  let naAsaas = null;
  let erroAsaas = null;
  if (empresa.asaas_pix_auto_authorization_id) {
    try {
      naAsaas = cliente.resumoDaAutorizacao(await cliente.consultarAutorizacao(empresa.asaas_pix_auto_authorization_id));
    } catch (err) {
      erroAsaas = err.message;
    }
  }
  return {
    company: { id: empresa.id, nome: empresa.nome },
    pix_auto_status: empresa.pix_auto_status || null,
    authorization_id: empresa.asaas_pix_auto_authorization_id || null,
    assinatura_atual: empresa.asaas_subscription_id || null,
    na_asaas: naAsaas,
    erro_asaas: erroAsaas,
    historico,
  };
}

async function elegibilidade({ db }) {
  try {
    const r = await db.query(
      `SELECT status, ineligible_reasons, account_id, event_date, updated_at
         FROM pix_automatico_elegibilidade WHERE id = 1`
    );
    return r.rows[0] || { status: null, nota: 'Nenhum evento de elegibilidade recebido ainda.' };
  } catch (e) {
    if (e.code === '42P01') return { status: null, nota: 'Migration 406 não aplicada.' };
    throw e;
  }
}

module.exports = {
  iniciarAutorizacao,
  trocarAssinatura,
  estado,
  elegibilidade,
  somarMeses,
  contractIdPara,
  hojeBrt,
};
