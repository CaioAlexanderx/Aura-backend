// ============================================================
// "Precisa de voce" no painel (04/09/2026)
//
// Decisao do Caio: o painel de metricas fica — nem toda lojista enxerga
// a rotina do mesmo jeito, e uma lista fixa frustraria quem prefere
// olhar o numero. Mas a acao urgente nao pode se esconder atras do
// grafico: uma faixa fina acima dos KPIs diz o que esta esperando ELA.
// ============================================================
const fs = require('fs');
const path = require('path');

const rota = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'studioPainel.js'), 'utf8');

describe('as tres contagens', () => {
  test('sao do estado ATUAL, nao do periodo', () => {
    // Uma arte esperando aprovacao ha 40 dias continua esperando; filtrar
    // por periodo a esconderia justamente quando mais importa.
    const bloco = rota.slice(rota.indexOf('out.precisa_de_voce ='), rota.indexOf('res.json(out);'));
    expect(bloco).toContain("status = 'pending'");
    expect(bloco).toContain("status = 'pending_payment'");
    expect(bloco).toContain("status = 'draft'");
    expect(bloco).not.toContain('created_at >=');
  });

  test('cada uma filtra pela empresa', () => {
    const bloco = rota.slice(rota.indexOf('out.precisa_de_voce ='), rota.indexOf('res.json(out);'));
    expect((bloco.match(/company_id = \$1/g) || []).length).toBe(3);
  });

  test('tabela ausente numa base nao apaga as outras contagens', () => {
    // Cada consulta tem o proprio try; 42P01 e silencioso (armadilha 10).
    // O zero inicial vem ANTES do helper: e ele que garante as tres chaves
    // mesmo quando toda consulta falha.
    const bloco = rota.slice(rota.indexOf('out.precisa_de_voce ='), rota.indexOf('res.json(out);'));
    expect(bloco).toContain("err.code !== '42P01'");
    expect(bloco).toContain('out.precisa_de_voce = { artes_aguardando_cliente: 0, pedidos_nao_pagos: 0, orcamentos_novos: 0 }');
  });
});
