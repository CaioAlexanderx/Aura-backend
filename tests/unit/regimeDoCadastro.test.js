// ============================================================
// AURA. -- Testes: decisao do regime no cadastro e regime da Receita
// (b-tq-regime-cadastro, 17/11/2026)
// ============================================================
const { decidirRegime, consultarReceita, cnpjConsultavel } = require('../../src/services/regimeDoCadastro');
const { regimeDaReceita } = jest.requireActual('../../src/services/cnpj');

const rf = (regime, fonte = 'receita', confirmar = false) => ({ suggested_regime: regime, regime_fonte: fonte, regime_confirmar: confirmar });

describe('regimeDaReceita -- MEI sem dado nao vira Simples confirmado', () => {
  test('cnpj.ws: MEI Sim -> mei (receita)', () => {
    expect(regimeDaReceita({ simples: { simples: 'Sim', mei: 'Sim' } })).toEqual({ regime: 'mei', fonte: 'receita', confirmar: false });
  });
  test('cnpj.ws: Simples Sim e MEI Nao -> simples_nacional (receita)', () => {
    expect(regimeDaReceita({ simples: { simples: 'Sim', mei: 'Não' } })).toEqual({ regime: 'simples_nacional', fonte: 'receita', confirmar: false });
  });
  test('BrasilAPI/CNPJa: Simples Sim e MEI nulo -> simples_nacional ESTIMADO (pode ser MEI)', () => {
    expect(regimeDaReceita({ simples: { simples: 'Sim', mei: null } })).toEqual({ regime: 'simples_nacional', fonte: 'estimado', confirmar: true });
  });
  test('fora do Simples -> lucro_presumido a confirmar (receita)', () => {
    expect(regimeDaReceita({ simples: { simples: 'Não', mei: 'Não' } })).toEqual({ regime: 'lucro_presumido', fonte: 'receita', confirmar: true });
  });
  test('sem bloco: heuristica de porte, estimado', () => {
    expect(regimeDaReceita({ porte: { descricao: 'MICRO EMPRESA' } }).fonte).toBe('estimado');
  });
});

describe('decidirRegime', () => {
  test('CPF: sempre null', () => {
    expect(decidirRegime({ temCpf: true, regimeDoCorpo: 'mei', receita: { rf: rf('mei') } })).toMatchObject({ regime: null, origem: 'cpf' });
  });
  test('Receita confiavel vence corpo ausente e corpo divergente', () => {
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: undefined, receita: { rf: rf('mei') } })).toMatchObject({ regime: 'mei', origem: 'receita' });
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: 'simples_nacional', receita: { rf: rf('mei') } })).toMatchObject({ regime: 'mei', origem: 'receita' });
  });
  test('fora do Simples: Presumido/Real do corpo fica; Simples do corpo nao', () => {
    const fora = { rf: rf('lucro_presumido', 'receita', true) };
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: 'lucro_real', receita: fora }).regime).toBe('lucro_real');
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: 'simples_nacional', receita: fora }).regime).toBe('lucro_presumido');
  });
  test('estimado ou falha: corpo valido, senao null (default da coluna)', () => {
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: 'mei', receita: { rf: rf('simples_nacional', 'estimado', true) } })).toMatchObject({ regime: 'mei', origem: 'corpo' });
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: undefined, receita: { erro: 'timeout' } })).toMatchObject({ regime: null, origem: 'padrao' });
    expect(decidirRegime({ temCpf: false, regimeDoCorpo: 'invalido', receita: null })).toMatchObject({ regime: null, origem: 'padrao' });
  });
});

describe('consultarReceita', () => {
  test('resposta dentro do prazo', async () => {
    const { resultado } = consultarReceita(async () => rf('mei'), '11222333000181', null, { prazoMs: 200 });
    await expect(resultado).resolves.toEqual({ rf: rf('mei') });
  });
  test('Receita lenta: o prazo corta e nao rejeita', async () => {
    const { resultado } = consultarReceita(() => new Promise(() => {}), '11222333000181', null, { prazoMs: 20 });
    const r = await resultado;
    expect(r.erro).toContain('prazo');
  });
  test('lookup que lanca (sincrono ou nao) vira erro, nunca rejeicao', async () => {
    const sinc = consultarReceita(() => { throw new Error('CNPJ inválido'); }, 'x', null, { prazoMs: 50 });
    await expect(sinc.resultado).resolves.toEqual({ erro: 'CNPJ inválido' });
    await expect(sinc.bruta).rejects.toThrow('CNPJ inválido');
  });
  test('cnpjConsultavel: so 14 digitos', () => {
    expect(cnpjConsultavel('11.222.333/0001-81')).toBe('11222333000181');
    expect(cnpjConsultavel('52998224725')).toBeNull();
    expect(cnpjConsultavel(undefined)).toBeNull();
  });
});
