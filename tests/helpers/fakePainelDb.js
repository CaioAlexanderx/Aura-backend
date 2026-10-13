// ============================================================
// Banco de mentira do painel da Gestão Aura.
//
// Um conjunto pequeno de lojas inventadas (nenhuma é cliente real) e um
// roteador de SQL: cada consulta dos blocos, dos alertas e das rotas cai
// numa linha de `responder`. Consulta que ninguém conhece LANÇA — assim um
// SQL novo sem teste aparece em vez de voltar vazio.
//
// "Hoje" é 13/10/2026 (terça). As fixtures em tests/fixtures/painel/ são o
// que as rotas devolvem para estes dados.
// ============================================================
'use strict';

const HOJE = '2026-10-13';
// 09:00 em Brasília do dia 13/10.
const AGORA = new Date('2026-10-13T12:00:00.000Z');

const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
// Tenant Aura (AURA_COMPANY_ID) e as conversas do WhatsApp da Aura no hub.
const AURA_COMPANY = 'eeeeeeee-0000-4000-8000-000000000001';
const conv = (n) => `dddddddd-0000-4000-8000-00000000000${n}`;

const empresa = (n, nome, extra) => ({
  company_id: id(n), nome, telefone: `1199990000${n}`, plan: 'negocio', ciclo: 'monthly', status: 'trial',
  criado_em: '2026-06-06', trial_ate: null, vence_em: null, segment: null, vertical_active: null,
  por_codigo: false, tem_cobranca: false, eh_dojo: false, ...extra,
});

const EMPRESAS = [
  empresa(1, 'Loja Aurora', { status: 'active', ciclo: 'annual', vence_em: '2026-10-14', tem_cobranca: true, vertical_active: 'studio' }),
  empresa(2, 'Mercado Bela Vista', { status: 'active', vence_em: '2026-10-25', tem_cobranca: true, segment: 'varejo', criado_em: '2026-03-02' }),
  empresa(3, 'Casa do Construtor', { status: 'active', plan: 'essencial', ciclo: 'annual', vence_em: '2026-09-15', tem_cobranca: true, segment: 'matcon', criado_em: '2026-05-11' }),
  empresa(4, 'Dojô Central', { status: 'active', plan: 'essencial', telefone: null, vertical_active: 'karate_dojo', eh_dojo: true, criado_em: '2026-08-01' }),
  empresa(5, 'Ótica Visão', { criado_em: '2026-10-06', trial_ate: '2026-10-14', segment: 'otica' }),
  empresa(6, 'Bazar Novo', { criado_em: '2026-10-09', trial_ate: '2026-10-16', por_codigo: true, plan: 'essencial' }),
  empresa(7, 'Tech Assist', { criado_em: '2026-10-01', trial_ate: '2026-10-08', segment: 'assistencia' }),
  empresa(8, 'Papelaria Sol', { status: 'active', criado_em: '2026-09-20', vence_em: '2026-10-20', tem_cobranca: true }),
];

const ts = (dia, hora = '15:00') => `${dia}T${hora}:00.000Z`;

function dadosPadrao() {
  return {
    empresas: EMPRESAS.map((e) => ({ ...e })),
    // trials_degrau
    funil: [
      { company_id: id(5), produtos: '40', vendas: '3', checkout_em: null },
      { company_id: id(6), produtos: '12', vendas: '0', checkout_em: null },
      { company_id: id(7), produtos: '0', vendas: '0', checkout_em: ts('2026-10-09') },
      { company_id: id(8), produtos: '85', vendas: '31', checkout_em: null },
    ],
    vendasPeriodo: [
      { company_id: id(1), vendas: '4', ultima: ts('2026-09-21') },
      { company_id: id(2), vendas: '120', ultima: ts('2026-10-12') },
      { company_id: id(3), vendas: '18', ultima: ts('2026-10-10') },
      { company_id: id(5), vendas: '3', ultima: ts('2026-10-11') },
      { company_id: id(8), vendas: '31', ultima: ts('2026-10-12') },
    ],
    ultimaVenda: [
      { company_id: id(1), vendas: '79', ultima: ts('2026-09-21') },
      { company_id: id(2), vendas: '940', ultima: ts('2026-10-12') },
      { company_id: id(3), vendas: '60', ultima: ts('2026-10-10') },
      { company_id: id(5), vendas: '3', ultima: ts('2026-10-11') },
      { company_id: id(8), vendas: '31', ultima: ts('2026-10-12') },
    ],
    acessoPeriodo: [
      { company_id: id(1), dias_ativos: '3', acessos: '3', ultimo: ts('2026-10-08') },
      { company_id: id(2), dias_ativos: '26', acessos: '71', ultimo: ts('2026-10-13', '11:00') },
      { company_id: id(3), dias_ativos: '14', acessos: '20', ultimo: ts('2026-10-12') },
      { company_id: id(5), dias_ativos: '5', acessos: '6', ultimo: ts('2026-10-12') },
      { company_id: id(6), dias_ativos: '2', acessos: '2', ultimo: ts('2026-10-10') },
      { company_id: id(8), dias_ativos: '11', acessos: '15', ultimo: ts('2026-10-12') },
    ],
    acessoSemana: [
      ...[1, 2, 3].map((n) => ({ semana: '2026-09-28', company_id: id(n) })),
      ...[2, 3, 5, 8].map((n) => ({ semana: '2026-10-05', company_id: id(n) })),
      ...[2, 3, 5, 6, 8].map((n) => ({ semana: '2026-10-12', company_id: id(n) })),
    ],
    ultimoAcesso: [1, 2, 3, 5, 6, 7, 8].map((n) => ({ company_id: id(n), ultimo: ts('2026-10-12') })),
    acoes: [
      { action: 'login', n: '117', lojas: '6' },
      { action: 'login_failed', n: '9', lojas: '3' },
      { action: 'switch_company', n: '40', lojas: '2' },
    ],
    vendasHora: [
      { company_id: id(2), hora: 10, vendas: '30' },
      { company_id: id(2), hora: 16, vendas: '90' },
      { company_id: id(3), hora: 9, vendas: '18' },
      { company_id: id(8), hora: 16, vendas: '31' },
      { company_id: id(5), hora: 19, vendas: '3' },
    ],
    vendasDia: [
      { company_id: id(2), dia: '2026-10-12', vendas: '9' },
      { company_id: id(8), dia: '2026-10-12', vendas: '4' },
      { company_id: id(2), dia: '2026-10-10', vendas: '21' },
      { company_id: id(3), dia: '2026-10-10', vendas: '6' },
      { company_id: id(5), dia: '2026-10-11', vendas: '3' },
      { company_id: id(2), dia: '2026-10-03', vendas: '17' },
      // conta interna: fora do universo, não pode aparecer
      { company_id: 'cccccccc-0000-4000-8000-000000000009', dia: '2026-10-12', vendas: '50' },
    ],
    nfceDia: [
      { company_id: id(2), dia: '2026-10-10', emitidas: '21', rejeitadas: '1' },
      { company_id: id(2), dia: '2026-10-12', emitidas: '9', rejeitadas: '0' },
      { company_id: id(8), dia: '2026-10-12', emitidas: '4', rejeitadas: '0' },
    ],
    nfceMotivo: [{ company_id: id(2), motivo: 'Rejeição 327: CFOP inválido' }],
    nfceRejeitadas: [{ company_id: id(2), rejeitadas: '1', motivo: 'Rejeição 327: CFOP inválido' }],
    parcelas: [
      { company_id: id(2), parcelas: '107', clientes: '41', valor: '8450.50', mais_antiga: '2026-06-10' },
      { company_id: id(8), parcelas: '12', clientes: '5', valor: '930.00', mais_antiga: '2026-09-30' },
      { company_id: id(3), parcelas: '4', clientes: '2', valor: '310.20', mais_antiga: '2026-10-01' },
    ],
    leads: [
      { id: 'l1', name: 'Marina Prado', phone: '11988880001', city: 'Jacareí', source: 'site', status: 'contacted', created_at: ts('2026-10-11', '17:20'), converted_company_id: null },
      { id: 'l2', name: 'Otávio Reis', phone: '11988880002', city: 'São José dos Campos', source: 'site_partial', status: 'new', created_at: ts('2026-10-08', '12:05'), converted_company_id: null },
      { id: 'l3', name: 'Bazar Novo', phone: '11999900006', city: 'Jacareí', source: 'site', status: 'won', created_at: ts('2026-09-25', '14:00'), converted_company_id: id(6) },
    ],
    // ── WhatsApp da Aura (hub) — "agora" é 09:00 BRT de 13/10 ──
    // 1. Renata (telefone da Mercado Bela Vista): chegou 23:40 de 12/10, a
    //    Aurinha respondeu na hora, o Caio só às 08:10 (510 min).
    // 2. número sem cadastro: 05:30, Aurinha respondeu, ninguém humano (3h30).
    // 3. Paulo Mendes: 11/10 14:00, Caio respondeu em 12 min.
    // 4. 08:50, sem resposta, 10 min de espera.
    // 5. 05/10 10:00, nunca respondido (fora da semana).
    hubConversas: [
      { id: conv(1), external_id: '5511999900002', customer_name: 'Renata Lima', status: 'humano', last_inbound_at: ts('2026-10-13', '02:40'), ultima_mensagem_humana_em: ts('2026-10-13', '11:10'), aguardando_resposta_desde: null, last_message_at: ts('2026-10-13', '11:10'), created_at: ts('2026-10-13', '02:40') },
      { id: conv(2), external_id: '5512988880077', customer_name: null, status: 'ia', last_inbound_at: ts('2026-10-13', '08:30'), ultima_mensagem_humana_em: null, aguardando_resposta_desde: null, last_message_at: ts('2026-10-13', '08:30'), created_at: ts('2026-10-13', '08:30') },
      { id: conv(3), external_id: '5511977770003', customer_name: 'Paulo Mendes', status: 'ia', last_inbound_at: ts('2026-10-11', '17:00'), ultima_mensagem_humana_em: ts('2026-10-11', '17:12'), aguardando_resposta_desde: null, last_message_at: ts('2026-10-11', '17:12'), created_at: ts('2026-10-11', '17:00') },
      { id: conv(4), external_id: '5511966660004', customer_name: null, status: 'ia', last_inbound_at: ts('2026-10-13', '11:50'), ultima_mensagem_humana_em: null, aguardando_resposta_desde: ts('2026-10-13', '11:50'), last_message_at: ts('2026-10-13', '11:50'), created_at: ts('2026-10-13', '11:50') },
      { id: conv(5), external_id: '5511955550005', customer_name: null, status: 'ia', last_inbound_at: ts('2026-10-05', '13:00'), ultima_mensagem_humana_em: null, aguardando_resposta_desde: null, last_message_at: ts('2026-10-05', '13:00'), created_at: ts('2026-10-05', '13:00') },
    ],
    hubMensagens: [
      { id: 'm01', conversation_id: conv(5), direction: 'inbound', author: 'cliente', content: 'Vocês têm app?', created_at: ts('2026-10-05', '13:00') },
      { id: 'm02', conversation_id: conv(3), direction: 'inbound', author: 'cliente', content: 'Quanto custa o plano Negócio?', created_at: ts('2026-10-11', '17:00') },
      { id: 'm03', conversation_id: conv(3), direction: 'outbound', author: 'humano', content: 'R$ 169 por mês.', created_at: ts('2026-10-11', '17:12') },
      { id: 'm04', conversation_id: conv(1), direction: 'inbound', author: 'cliente', content: 'Oi, vocês fazem integração\ncom iFood?', created_at: ts('2026-10-13', '02:40') },
      { id: 'm05', conversation_id: conv(1), direction: 'outbound', author: 'aurinha', content: 'Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h.', created_at: '2026-10-13T02:40:20.000Z' },
      { id: 'm06', conversation_id: conv(1), direction: 'outbound', author: 'humano', content: 'Oi, Renata! Fazemos sim.', created_at: ts('2026-10-13', '11:10') },
      { id: 'm07', conversation_id: conv(2), direction: 'inbound', author: 'cliente', content: 'Preciso de ajuda com a nota fiscal', created_at: ts('2026-10-13', '08:30') },
      { id: 'm08', conversation_id: conv(2), direction: 'outbound', author: 'aurinha', content: 'Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h.', created_at: '2026-10-13T08:30:20.000Z' },
      { id: 'm09', conversation_id: conv(4), direction: 'inbound', author: 'cliente', content: 'Bom dia!', created_at: ts('2026-10-13', '11:50') },
    ],
    hubEventos: [
      { conversation_id: conv(1), type: 'resposta_enfileirada', detail: { outbox_id: 'o1', status: 'pending', motivo: null, parada: false }, created_at: '2026-10-13T02:40:19.000Z' },
      { conversation_id: conv(1), type: 'mensagem_humana', detail: { canal: 'whatsapp', origem: 'app_do_celular' }, created_at: ts('2026-10-13', '11:10') },
      { conversation_id: conv(2), type: 'resposta_enfileirada', detail: { outbox_id: 'o2', status: 'pending', motivo: null, parada: false }, created_at: '2026-10-13T08:30:19.000Z' },
      { conversation_id: conv(3), type: 'mensagem_humana', detail: { canal: 'whatsapp', origem: 'painel' }, created_at: ts('2026-10-11', '17:12') },
    ],
    // telefone cadastrado (empresa ou dono) que bate com um contato
    hubEmpresas: [
      { company_id: id(2), nome: 'Mercado Bela Vista', telefone: '(11) 99990-0002' },
    ],
    telas: [
      { screen: 'pdv', company_id: id(2), v7: '210', vp: '640', ultimo: ts('2026-10-13', '11:00') },
      { screen: 'pdv', company_id: id(8), v7: '40', vp: '95', ultimo: ts('2026-10-12') },
      { screen: 'relatorios', company_id: id(2), v7: '6', vp: '22', ultimo: ts('2026-10-12') },
      { screen: 'etiquetas', company_id: id(3), v7: '0', vp: '3', ultimo: ts('2026-10-02') },
    ],
    // uso por módulo, por tabela
    uso: {
      sales: [[2, 60, 120, 940], [3, 5, 18, 60], [5, 3, 3, 3], [8, 12, 31, 31], [1, 0, 4, 79]],
      products: [[2, 15, 80, 900], [3, 0, 12, 300], [5, 40, 40, 40], [6, 12, 12, 12], [8, 5, 85, 85], [1, 0, 0, 210]],
      customers: [[2, 9, 33, 610], [8, 3, 14, 14], [5, 2, 2, 2]],
      customer_credit_transactions: [[2, 44, 190, 2100], [8, 6, 20, 20]],
      caixa_sessoes: [[2, 6, 26, 200], [8, 4, 11, 11]],
      import_logs: [[5, 1, 1, 1], [6, 1, 1, 1]],
      nfce_emissions: [[2, 30, 96, 571], [8, 4, 4, 4]],
      service_orders: [[7, 0, 0, 2]],
      matcon_quotes: [[3, 2, 7, 19]],
      studio_orders: [[1, 0, 1, 44]],
      report_deliveries: [[2, 1, 4, 20]],
    },
    snapshots: [
      { mes: '2026-09', mrr_total: '310.83' },
      { mes: '2026-08', mrr_total: '140.83' },
    ],
    asaasPorMes: [
      { mes: '2026-09', event: 'PAYMENT_RECEIVED', n: '3', total: '479.66' },
      { mes: '2026-10', event: 'PAYMENT_RECEIVED', n: '2', total: '309.83' },
      { mes: '2026-10', event: 'PAYMENT_OVERDUE', n: '1', total: '74.17' },
    ],
    asaasEventos: [
      { id: 'w4', company_id: null, event: 'PAYMENT_RECEIVED', processed_at: ts('2026-10-12', '13:10'), valor: '140.83' },
      { id: 'w3', company_id: id(2), event: 'PAYMENT_RECEIVED', processed_at: ts('2026-10-05', '09:00'), valor: '169.00' },
      { id: 'w2', company_id: id(3), event: 'PAYMENT_OVERDUE', processed_at: ts('2026-10-02', '09:00'), valor: '74.17' },
      { id: 'w1', company_id: id(1), event: 'PAYMENT_DELETED', processed_at: ts('2026-09-21', '09:00'), valor: '140.83' },
    ],
    // um por cobrança paga, mês corrente e anterior (w4 não achou loja)
    asaasRecebidos: [
      { id: 'w4', company_id: null, event: 'PAYMENT_RECEIVED', processed_at: ts('2026-10-12', '13:10'), mes_recebido: '2026-10', valor: '140.83', pagamento_id: 'pay_004', cliente_asaas: 'cus_000004', vencimento: '2026-10-12' },
      { id: 'w3', company_id: id(2), event: 'PAYMENT_RECEIVED', processed_at: ts('2026-10-05', '09:00'), mes_recebido: '2026-10', valor: '169.00', pagamento_id: 'pay_003', cliente_asaas: 'cus_000002', vencimento: '2026-10-05' },
      { id: 'w0c', company_id: id(8), event: 'PAYMENT_CONFIRMED', processed_at: ts('2026-09-20', '09:00'), mes_recebido: '2026-09', valor: '169.83', pagamento_id: 'pay_00c', cliente_asaas: 'cus_000008', vencimento: '2026-09-20' },
      { id: 'w0b', company_id: id(1), event: 'PAYMENT_RECEIVED', processed_at: ts('2026-09-14', '09:00'), mes_recebido: '2026-09', valor: '140.83', pagamento_id: 'pay_00b', cliente_asaas: 'cus_000001', vencimento: '2026-09-14' },
      { id: 'w0a', company_id: id(2), event: 'PAYMENT_RECEIVED', processed_at: ts('2026-09-05', '09:00'), mes_recebido: '2026-09', valor: '169.00', pagamento_id: 'pay_00a', cliente_asaas: 'cus_000002', vencimento: '2026-09-05' },
    ],
    // conferência com o extrato (migration 373): pagamentos de meses mais antigos
    // e o extrato de setembro (2 créditos casados com a Asaas, 1 sem pagamento).
    asaasConferencia: [],
    extratos: [
      {
        id: '7', mes: '2026-09', nome_arquivo: 'extrato-setembro.ofx', importado_em: ts('2026-10-02', '12:00'),
        total_creditos: '359.83', linhas: 4,
        conciliados_n: '2', conciliados_valor: '309.83', pendentes_n: '1', pendentes_valor: '50.00', ignorados_n: '0',
      },
    ],
    extratoCasados: [{ conciliado_com: 'pay_00a' }, { conciliado_com: 'pay_00b' }],
    asaasSemLoja: [{ id: 'w4', processed_at: ts('2026-10-12', '13:10'), valor: '140.83' }],
    // linhas de 7 e 30 dias atrás, para a variação
    anteriores: [
      { dia: '2026-10-06', bloco: 'pagantes', valor: 4 },
      { dia: '2026-09-13', bloco: 'pagantes', valor: 3 },
      { dia: '2026-10-06', bloco: 'receita', valor: 479.66 },
    ],
    // preenchidos pelos testes
    gravados: [],
    alertasGravados: [],
    layout: null,
    // ficha da Loja Aurora
    ficha: {
      cliente: {
        id: id(1), trade_name: 'Loja Aurora', legal_name: 'Aurora Personalizados LTDA', plan: 'negocio', is_active: true,
        billing_status: 'active', billing_cycle: 'annual', module_overrides: null,
        created_at: ts('2026-06-06'), last_active_at: ts('2026-10-08'), tax_regime: 'simples', trial_ends_at: null,
        vertical_active: 'studio', vertical_enabled_at: null, suggested_vertical: null,
        owner_email: 'dona@lojaaurora.example', owner_name: 'Helena Duarte', owner_phone: '11999900001', owner_is_staff: false,
        is_sandbox: false, access_code_used: null, has_subscription: true,
        health_score: 45, risk_level: 'attention', activity_score: 25, usage_score: 5, payment_score: 25, adoption_score: 15,
        tx_count: '140', prod_count: '210', cust_count: '58', sale_count: '79', total_revenue: '18250.40',
        last_login_at: ts('2026-10-08'), login_days: '3',
        first_sale_at: ts('2026-06-09'), checkout_viewed_at: null, checkout_views: '0',
      },
      logins: [{ logins: '3', dias_ativos: '3', ultimo: ts('2026-10-08') }],
      asaas: [
        { event: 'PAYMENT_DELETED', processed_at: ts('2026-09-21', '09:00'), valor: '140.83', vencimento: '2026-10-14' },
        { event: 'PAYMENT_RECEIVED', processed_at: ts('2026-09-14', '09:00'), valor: '140.83', vencimento: '2026-09-14' },
      ],
      linhaDoTempo: [
        { tipo: 'login', quando: ts('2026-10-08'), valor: null, detalhe: 'login' },
        { tipo: 'pagamento', quando: ts('2026-09-21', '09:00'), valor: '140.83', detalhe: 'PAYMENT_DELETED' },
        { tipo: 'venda', quando: ts('2026-09-21', '18:30'), valor: '189.90', detalhe: 'completed' },
        { tipo: 'nota', quando: ts('2026-09-21', '18:31'), valor: '189.90', detalhe: 'autorizada' },
        { tipo: 'pagamento', quando: ts('2026-09-14', '09:00'), valor: '140.83', detalhe: 'PAYMENT_RECEIVED' },
      ],
      vendasSemana: [
        { semana: '2026-09-21', vendas: '1' },
        { semana: '2026-09-14', vendas: '3' },
        { semana: '2026-08-31', vendas: '6' },
      ],
    },
  };
}

function usoRows(linhas, companyId) {
  return (linhas || [])
    .map(([n, e7, ep, total]) => ({ company_id: id(n), e7: String(e7), ep: String(ep), total: String(total), ultimo: ts('2026-10-12') }))
    .filter((r) => !companyId || r.company_id === companyId);
}

// Devolve as linhas de uma consulta. `escritas` acumula INSERT/UPDATE/DELETE.
function responder(dados, escritas, sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const escrever = (tabela) => { escritas.push({ tabela, sql: s, params }); return []; };

  // ── WhatsApp da Aura (hub) ──
  if (s.includes('-- contatos:mensagens ')) return dados.hubMensagens;
  if (s.includes('-- contatos:conversas ')) return dados.hubConversas;
  if (s.includes('-- contatos:eventos-conversa ')) return dados.hubEventos.filter((e) => e.conversation_id === params[0]);
  if (s.includes('-- contatos:eventos ')) return dados.hubEventos;
  if (s.includes('-- contatos:empresas ')) return dados.hubEmpresas;
  if (s.includes('-- contatos:conversa ')) return dados.hubConversas.filter((c) => c.id === params[0] && params[1] === AURA_COMPANY);
  if (s.includes('-- contatos:thread ')) {
    return dados.hubMensagens.filter((m) => m.conversation_id === params[0])
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
  }

  // ── tabelas do painel ──
  if (s.startsWith('INSERT INTO painel_blocos_diarios')) return escrever('painel_blocos_diarios');
  if (s.includes('FROM painel_blocos_diarios WHERE dia IN')) return dados.anteriores;
  if (s.includes('FROM painel_blocos_diarios WHERE dia = $1::date AND bloco = $2')) {
    return dados.gravados.filter((g) => g.bloco === params[1]);
  }
  if (s.includes('FROM painel_blocos_diarios')) return dados.gravados;
  if (s.startsWith('DELETE FROM painel_alertas') || s.startsWith('INSERT INTO painel_alertas')) return escrever('painel_alertas');
  if (s.includes('FROM painel_alertas WHERE dia = $1::date AND company_id = $2')) {
    return dados.alertasGravados.filter((a) => a.company_id === params[1]);
  }
  if (s.includes('FROM painel_alertas')) return dados.alertasGravados;
  if (s.startsWith('INSERT INTO painel_layout')) {
    escrever('painel_layout');
    return [{ updated_at: AGORA.toISOString() }];
  }
  if (s.includes('FROM painel_layout')) return dados.layout ? [dados.layout] : [];

  // ── extrato OFX × Asaas (migration 373) ──
  if (s.includes('FROM aura_extratos e')) return dados.extratos;
  if (s.includes('FROM aura_extrato_lancamentos')) return dados.extratoCasados;

  // ── ficha (antes das consultas genéricas das mesmas tabelas) ──
  if (s.includes("(SELECT 'venda' AS tipo")) return dados.ficha.linhaDoTempo;
  if (s.includes('ck ON true')) return dados.ficha.cliente && (!params[0] || params[0] === dados.ficha.cliente.id) ? [{ ...dados.ficha.cliente }] : [];
  if (s.includes('AS caixa_sessions')) return [{ company_id: id(1), caixa_sessions: '14', last_caixa_at: ts('2026-09-21') }];
  if (s.includes('AS imported_rows')) return [];
  if (s.includes('extra_seats_granted')) return [];
  if (s.includes("FILTER (WHERE action = 'login') AS logins")) return dados.ficha.logins;
  if (s.includes('FROM webhook_logs WHERE company_id = $1') && s.includes('AS vencimento')) return dados.ficha.asaas;
  if (s.includes('AS semana, COUNT(*) AS vendas')) return dados.ficha.vendasSemana;

  // ── uso por módulo ──
  if (s.includes('AS e7')) {
    const tabela = /FROM (\w+) WHERE company_id IS NOT NULL/.exec(s)[1];
    return usoRows(dados.uso[tabela], s.includes('company_id = $2') ? params[1] : null);
  }

  // ── empresas, receita, health ──
  if (s.includes('AS eh_dojo')) return dados.empresas;
  if (s.includes("WHERE c.billing_status = 'active'") && s.includes('AS tem_cobranca')) {
    return dados.empresas.filter((e) => e.status === 'active');
  }
  if (s.includes('AS last_sale_at')) {
    return dados.empresas.filter((e) => !e.eh_dojo).map((e) => ({
      id: e.company_id, plan: e.plan, billing_status: e.status, last_active_at: null,
      last_sale_at: (dados.ultimaVenda.find((v) => v.company_id === e.company_id) || {}).ultima || null,
      sales_30d: (dados.vendasPeriodo.find((v) => v.company_id === e.company_id) || {}).vendas || '0',
    }));
  }
  if (s.startsWith('INSERT INTO client_health_scores')) return escrever('client_health_scores');
  if (s.startsWith('INSERT INTO aura_revenue_snapshot')) return escrever('aura_revenue_snapshot');
  if (s.includes('FROM aura_revenue_snapshot')) return dados.snapshots;

  // ── blocos ──
  if (s.includes('FROM products p WHERE p.company_id = c.id')) {
    return dados.funil.filter((f) => params[0].includes(f.company_id));
  }
  if (s.includes('FROM webhook_logs')) {
    if (s.includes('AS mes_conf')) return dados.asaasConferencia;
    if (s.includes('AS mes_recebido')) return dados.asaasRecebidos;
    if (s.includes('AS mes')) return dados.asaasPorMes;
    if (s.includes('company_id IS NULL')) return dados.asaasSemLoja;
    return dados.asaasEventos;
  }
  if (s.includes('FROM sales_leads')) return dados.leads;
  if (s.includes('FROM sales')) {
    if (s.includes('AS hora')) return dados.vendasHora;
    if (s.includes('AS dia')) return dados.vendasDia;
    if (s.includes('WHERE created_at >=')) return dados.vendasPeriodo;
    return dados.ultimaVenda;
  }
  if (s.includes('FROM audit_log')) {
    if (s.includes('AS semana')) return dados.acessoSemana;
    if (s.includes('AS dias_ativos')) return dados.acessoPeriodo;
    if (s.startsWith('SELECT action')) return dados.acoes;
    return dados.ultimoAcesso;
  }
  if (s.includes('FROM nfce_emissions')) {
    if (s.includes('AS emitidas')) return dados.nfceDia;
    if (s.includes('DISTINCT ON')) return dados.nfceMotivo;
    return dados.nfceRejeitadas;
  }
  if (s.includes('FROM credit_installments')) return dados.parcelas;
  if (s.includes('FROM screen_views')) return dados.telas;

  throw new Error('SQL inesperado no banco de mentira do painel: ' + s.slice(0, 160));
}

// Liga o banco de mentira num jest.fn (db.query). Devolve { dados, escritas }.
function ligar(query, dados = dadosPadrao()) {
  const escritas = [];
  query.mockImplementation(async (sql, params) => {
    const rows = responder(dados, escritas, sql, params);
    return { rows, rowCount: rows.length };
  });
  return { dados, escritas };
}

module.exports = { HOJE, AGORA, USER, AURA_COMPANY, conv, id, ts, EMPRESAS, dadosPadrao, responder, ligar };
