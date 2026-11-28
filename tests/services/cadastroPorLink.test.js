// ============================================================
// AURA. -- Testes: regras puras do cadastro por link (p-209)
//
// Travam: token (formato e hash), validação do formulário (CPF, data com
// ano, nome completo, aceite, chave fora da lista), e a junção com o
// cadastro existente (vazio preenche, diferente vira pendência, endereço
// é um bloco só, 1904 é "sem ano", nome provisório conta como vazio).
// ============================================================
const {
  gerarToken, hashToken, tokenComFormato, lerFormulario, planejarGravacao,
  colunasDaPendencia, estadoDoLink,
} = require('../../src/services/cadastroPorLink');

const CPF = '52998224725'; // válido (exemplo clássico de documentação)
const ACEITE = { accepted: true, version: 'v1-teste' };
const base = (extra) => ({ name: 'Maria Souza', birth_date: '15/06/1990', cpf: '529.982.247-25', consent: ACEITE, ...extra });

describe('token', () => {
  it('43 letras base64url, hash de 64 hex, nunca igual', () => {
    const a = gerarToken(); const b = gerarToken();
    expect(tokenComFormato(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenComFormato('curto')).toBe(false);
    expect(tokenComFormato(`${'a'.repeat(42)}/`)).toBe(false);
  });
});

describe('lerFormulario', () => {
  it('aceita o mínimo e normaliza', () => {
    const r = lerFormulario(base());
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ name: 'Maria Souza', birth_date: '1990-06-15', cpf_cnpj: CPF });
    expect(r.consentVersion).toBe('v1-teste');
  });
  it('sem aceite -> ACEITE_OBRIGATORIO', () => {
    expect(lerFormulario(base({ consent: { accepted: false, version: 'v1' } })).code).toBe('ACEITE_OBRIGATORIO');
    expect(lerFormulario(base({ consent: { accepted: true } })).code).toBe('ACEITE_OBRIGATORIO');
  });
  it('CPF inválido -> field cpf', () => {
    const r = lerFormulario(base({ cpf: '111.111.111-11' }));
    expect(r.ok).toBe(false); expect(r.field).toBe('cpf');
  });
  it('data sem ano, impossível ou no futuro -> field birth_date', () => {
    expect(lerFormulario(base({ birth_date: '15/06' })).field).toBe('birth_date');
    expect(lerFormulario(base({ birth_date: '31/02/1990' })).field).toBe('birth_date');
    expect(lerFormulario(base({ birth_date: '01/01/2999' })).field).toBe('birth_date');
  });
  it('nome sem sobrenome -> field name', () => {
    expect(lerFormulario(base({ name: 'Maria' })).field).toBe('name');
  });
  it('chave fora da lista (receita, notas) -> 422 FIELD_NOT_ALLOWED', () => {
    const r = lerFormulario(base({ od_sph: -1 }));
    expect(r.status).toBe(422); expect(r.code).toBe('FIELD_NOT_ALLOWED');
    expect(lerFormulario(base({ notes: 'x' })).code).toBe('FIELD_NOT_ALLOWED');
  });
  it('endereço vira bloco com as 7 chaves; CEP errado recusa', () => {
    const r = lerFormulario(base({ zip_code: '01310-100', street: 'Av. Paulista', number: '1000', city: 'São Paulo', state: 'sp' }));
    expect(r.values.address).toEqual({ zip_code: '01310100', street: 'Av. Paulista', number: '1000', complement: null, neighborhood: null, city: 'São Paulo', state: 'SP' });
    expect(lerFormulario(base({ zip_code: '123' })).field).toBe('zip_code');
  });
  it('e-mail e telefone opcionais, validados quando vêm', () => {
    expect(lerFormulario(base({ email: 'nao-e-email' })).field).toBe('email');
    expect(lerFormulario(base({ phone: '1234' })).field).toBe('phone');
    expect(lerFormulario(base({ email: 'Maria@Ex.com', phone: '(11) 99999-0000' })).values).toMatchObject({ email: 'maria@ex.com', phone: '(11) 99999-0000' });
  });
});

describe('planejarGravacao', () => {
  const recebido = {
    name: 'Maria Souza', birth_date: '1990-06-15', cpf_cnpj: CPF, phone: '11999990000', email: 'maria@ex.com',
    address: { zip_code: '01310100', street: 'Av. Paulista', number: '1000', complement: null, neighborhood: null, city: 'São Paulo', state: 'SP' },
  };

  it('cliente só com telefone: preenche tudo, nada pendente', () => {
    const p = planejarGravacao({ name: 'Maria Souza', phone: '(11) 99999-0000' }, recebido);
    expect(p.pending).toEqual({});
    expect(p.set).toMatchObject({ birth_date: '1990-06-15', cpf_cnpj: CPF, email: 'maria@ex.com', street: 'Av. Paulista', state: 'SP' });
    expect(p.set.name).toBeUndefined(); // igual: não regrava
    expect(p.set.phone).toBeUndefined();
    expect(p.filled.sort()).toEqual(['address', 'birth_date', 'cpf_cnpj', 'email']);
  });

  it('valor diferente vira pendência e NÃO entra no set', () => {
    const p = planejarGravacao({
      name: 'Maria S. Lima', cpf_cnpj: '11144477735', birth_date: new Date(1991, 0, 2), phone: '11888887777',
      email: 'outra@ex.com', street: 'Rua A', number: '1', city: 'Santos', state: 'SP',
    }, recebido);
    expect(Object.keys(p.set)).toEqual([]);
    expect(Object.keys(p.pending).sort()).toEqual(['address', 'birth_date', 'cpf_cnpj', 'email', 'name', 'phone']);
    expect(p.pending.address.street).toBe('Av. Paulista');
  });

  it('maiúscula, acento e espaço não contam como diferença', () => {
    const p = planejarGravacao({
      name: '  maria   souza ', email: 'MARIA@ex.com', city: 'SAO PAULO', street: 'av. paulista',
      number: '1000', zip_code: '01310100', state: 'SP',
    }, recebido);
    expect(p.pending).toEqual({});
  });

  it('nascimento 1904 com mesmo dia e mês é completar o ano', () => {
    const p = planejarGravacao({ birth_date: '1904-06-15' }, { birth_date: '1990-06-15' });
    expect(p.set.birth_date).toBe('1990-06-15');
    expect(p.pending).toEqual({});
    const q = planejarGravacao({ birth_date: '1904-07-01' }, { birth_date: '1990-06-15' });
    expect(q.pending.birth_date).toBe('1990-06-15');
  });

  it('nome provisório do link conta como vazio', () => {
    const p = planejarGravacao({ name: 'Cadastro por link pendente' }, { name: 'Maria Souza' }, { placeholderName: 'Cadastro por link pendente' });
    expect(p.set.name).toBe('Maria Souza');
    expect(p.pending).toEqual({});
  });

  it('aceitar o endereço grava o bloco inteiro (apaga o complemento antigo)', () => {
    expect(colunasDaPendencia('address', recebido.address)).toEqual({
      zip_code: '01310100', street: 'Av. Paulista', number: '1000', complement: null, neighborhood: null, city: 'São Paulo', state: 'SP',
    });
    expect(colunasDaPendencia('cpf_cnpj', CPF)).toEqual({ cpf_cnpj: CPF });
  });
});

describe('estadoDoLink', () => {
  const futuro = new Date(Date.now() + 86400000).toISOString();
  it('enviado, recebido, vencido, substituido', () => {
    expect(estadoDoLink({ expires_at: futuro })).toBe('enviado');
    expect(estadoDoLink({ expires_at: futuro, used_at: 'x' })).toBe('recebido');
    expect(estadoDoLink({ expires_at: new Date(Date.now() - 1000).toISOString() })).toBe('vencido');
    expect(estadoDoLink({ expires_at: futuro, revoked_at: 'x' })).toBe('substituido');
  });
});
