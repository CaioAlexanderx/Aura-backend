// 12/10/2026 — regime tributário pela Receita. Dois clientes reclamaram do
// regime cadastrado: o serviço inferia pela natureza jurídica (2135 → mei,
// resto → simples) e ignorava o bloco `simples` do cnpj.ws. Conferido em
// produção: 20 de 35 empresas com CNPJ estavam erradas.
const { regimeDaReceita } = require('../src/services/cnpj');

const ei = { natureza_juridica: { id: '2135', descricao: 'Empresário (Individual)' }, porte: { id: '01', descricao: 'Micro Empresa' } };
const ltda = { natureza_juridica: { id: '2062', descricao: 'Sociedade Empresária Limitada' }, porte: { id: '01', descricao: 'Micro Empresa' } };

describe('regimeDaReceita', () => {
  test('MEI optante é mei, mesmo sendo natureza 2135 com Simples sim', () => {
    expect(regimeDaReceita({ ...ei, simples: { mei: 'Sim', simples: 'Sim' } }))
      .toEqual({ regime: 'mei', fonte: 'receita', confirmar: false });
  });
  test('Empresário Individual que saiu do MEI e segue no Simples é Simples (caso Luciano Messias)', () => {
    expect(regimeDaReceita({ ...ei, simples: { mei: 'Não', simples: 'Sim', data_exclusao_mei: '2024-12-31' } }))
      .toEqual({ regime: 'simples_nacional', fonte: 'receita', confirmar: false });
  });
  test('LTDA no Simples é Simples', () => {
    expect(regimeDaReceita({ ...ltda, simples: { mei: 'Não', simples: 'Sim' } }).regime).toBe('simples_nacional');
  });
  test('fora do Simples: sugere Presumido e pede confirmação (Receita não distingue de Real)', () => {
    expect(regimeDaReceita({ ...ltda, simples: { mei: 'Não', simples: 'Não' } }))
      .toEqual({ regime: 'lucro_presumido', fonte: 'receita', confirmar: true });
  });
  test('sem o bloco simples: heurística de porte, marcada como estimada', () => {
    expect(regimeDaReceita({ ...ltda, porte: { descricao: 'DEMAIS' } })).toEqual({ regime: 'lucro_presumido', fonte: 'estimado', confirmar: true });
    expect(regimeDaReceita(ltda)).toEqual({ regime: 'simples_nacional', fonte: 'estimado', confirmar: true });
    expect(regimeDaReceita({ ...ltda, simples: { mei: null, simples: null } }).fonte).toBe('estimado');
  });
});
