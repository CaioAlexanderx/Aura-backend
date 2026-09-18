// ============================================================
// AURA CLIENTES — Fase 1 · perfil do cliente: funções puras
//
// Telefone (regra do nono dígito), CPF/CNPJ, tags/preferências/datas,
// agrupamento de duplicados e o merge de página da linha do tempo.
// A paridade do telefone com o SQL da migration 341 está em
// perfilCliente.banco.test.js (Postgres real no CI).
// ============================================================
'use strict';

const { toPhoneE164BR, phoneMatchCandidates } = require('../src/utils/phone');
const { isValidCpf, isValidCnpj, parseCpfCnpjInput } = require('../src/utils/cpfCnpj');
const fields = require('../src/services/customerProfileFields');
const { groupDuplicates, normalizeName, docKey } = require('../src/services/customerDuplicates');
const { mergePage, derivedKey, parseTimelineQuery } = require('../src/services/customerTimeline');
const { encodeCursor, decodeCursor } = require('../src/utils/timelineCursor');

// Lista compartilhada com o teste de paridade SQL.
const TELEFONES = require('./helpers/telefonesPerfilCliente');

describe('toPhoneE164BR — telefone do cliente', () => {
  it.each(TELEFONES)('%j -> %j', (entrada, esperado) => {
    expect(toPhoneE164BR(entrada)).toBe(esperado);
  });

  it('celular antigo (8 dígitos começando com 6-9) ganha o nono dígito', () => {
    for (const d of ['6', '7', '8', '9']) {
      expect(toPhoneE164BR(`21 ${d}1234567`)).toBe(`55219${d}1234567`);
    }
  });

  it('fixo (8 dígitos começando com 2-5) fica sem o 9', () => {
    for (const d of ['2', '3', '4', '5']) {
      expect(toPhoneE164BR(`21 ${d}1234567`)).toBe(`5521${d}1234567`);
    }
  });

  it('candidatos de busca no wa_outbox incluem o celular sem o 9', () => {
    expect(phoneMatchCandidates('(11) 98765-4321', null, '11 3456-7890')).toEqual([
      '5511987654321', '551187654321', '551134567890',
    ]);
    expect(phoneMatchCandidates(null, '', 'lixo')).toEqual([]);
  });
});

describe('CPF/CNPJ — dígito verificador', () => {
  it('aceita CPF válido com e sem máscara', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('recusa dígito errado, tamanho errado e sequência repetida', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('5299822472')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf(null)).toBe(false);
  });

  it('CNPJ também é conferido', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  it('entrada da ficha: vazio apaga, válido vira só dígitos, inválido explica', () => {
    expect(parseCpfCnpjInput('')).toEqual({ ok: true, value: null });
    expect(parseCpfCnpjInput('   ')).toEqual({ ok: true, value: null });
    expect(parseCpfCnpjInput(null)).toEqual({ ok: true, value: null });
    expect(parseCpfCnpjInput('529.982.247-25')).toEqual({ ok: true, value: '52998224725' });
    expect(parseCpfCnpjInput('11.222.333/0001-81')).toEqual({ ok: true, value: '11222333000181' });
    expect(parseCpfCnpjInput('529.982.247-24')).toEqual({ ok: false, error: 'CPF invalido' });
    expect(parseCpfCnpjInput('123').ok).toBe(false);
  });
});

describe('campos do perfil', () => {
  it('tags: trim, sem vazias, sem repetição ignorando caixa, aceita CSV', () => {
    expect(fields.parseTags(['  VIP ', 'vip', 'Noiva  2026', '', 'noiva 2026'])).toEqual({
      ok: true, value: ['VIP', 'Noiva 2026'],
    });
    expect(fields.parseTags('vip, atacado')).toEqual({ ok: true, value: ['vip', 'atacado'] });
    expect(fields.parseTags(null)).toEqual({ ok: true, value: [] });
    expect(fields.parseTags({ a: 1 }).ok).toBe(false);
    expect(fields.parseTags(['x'.repeat(41)]).ok).toBe(false);
    expect(fields.parseTags(Array.from({ length: 31 }, (_, i) => `t${i}`)).ok).toBe(false);
  });

  it('união de tags nunca falha a mesclagem, corta no teto', () => {
    const a = Array.from({ length: 20 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 20 }, (_, i) => `b${i}`);
    expect(fields.unionTags(a, b)).toHaveLength(fields.MAX_TAGS);
    expect(fields.unionTags(['VIP'], ['vip', 'Atacado'])).toEqual(['VIP', 'Atacado']);
  });

  it('preferências: objeto, tipos das chaves conhecidas, null remove', () => {
    expect(fields.parsePreferences({
      tamanho: ' M ', numeracao: 38, marcas: ['Farm', 'Farm', ' Animale '], estilo: 'casual', cor: 'azul', obs: null,
    })).toEqual({
      ok: true, value: { tamanho: 'M', numeracao: 38, marcas: ['Farm', 'Animale'], estilo: 'casual', cor: 'azul' },
    });
    expect(fields.parsePreferences([]).ok).toBe(false);
    expect(fields.parsePreferences({ marcas: 'Farm' }).ok).toBe(false);
    expect(fields.parsePreferences({ tamanho: 42 }).ok).toBe(false);
    expect(fields.parsePreferences({ observacoes: 'x'.repeat(9000) }).ok).toBe(false);
  });

  it('datas importantes: normaliza formatos e recusa data impossível', () => {
    expect(fields.parseImportantDates([
      { label: 'Casamento', date: '15/03/2020' },
      { label: 'Aniversário do filho', date: '2015-07-01' },
      { label: 'Namoro', date: '29/02' },
      { label: 'Formatura', date: '12-20' },
    ])).toEqual({
      ok: true,
      value: [
        { label: 'Casamento', date: '2020-03-15' },
        { label: 'Aniversário do filho', date: '2015-07-01' },
        { label: 'Namoro', date: '02-29' },
        { label: 'Formatura', date: '12-20' },
      ],
    });
    expect(fields.parseImportantDates([{ label: 'x', date: '31/02/2020' }]).ok).toBe(false);
    expect(fields.parseImportantDates([{ label: '', date: '2020-01-01' }]).ok).toBe(false);
    expect(fields.parseImportantDates({}).ok).toBe(false);
  });
});

describe('duplicados', () => {
  const base = (over) => ({
    company_id: 'co-a', company_name: 'Loja A', total_purchases: 0, total_spent: 0,
    created_at: '2026-01-01T00:00:00Z', ...over,
  });

  it('nome normalizado: sem acento, sem caixa, exige dois nomes', () => {
    expect(normalizeName('  JOSÉ  da Silva ')).toBe('jose da silva');
    expect(normalizeName('Maria')).toBeNull();
    expect(docKey('000.000.000-00')).toBeNull();
    expect(docKey('529.982.247-25')).toBe('52998224725');
  });

  it('telefone e CPF encadeiam num grupo forte só', () => {
    const grupos = groupDuplicates([
      base({ id: 'a', name: 'Ana Souza', phone: '(11) 98765-4321' }),
      base({ id: 'b', name: 'Ana S.', phone: '11 8765-4321', cpf_cnpj: '529.982.247-25', total_purchases: 5 }),
      base({ id: 'c', name: 'Ana', cpf_cnpj: '52998224725', company_id: 'co-b', company_name: 'Loja B' }),
      base({ id: 'd', name: 'Bruno Lima', phone: '21 3456-7890' }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].strength).toBe('forte');
    expect(grupos[0].reasons).toEqual(['cpf', 'phone']);
    expect(grupos[0].customers.map(c => c.id)).toEqual(['b', 'a', 'c']);
    expect(grupos[0].suggested_target_id).toBe('b');
  });

  it('nome igual vira grupo fraco só quando junta quem o forte não juntou', () => {
    const grupos = groupDuplicates([
      base({ id: 'a', name: 'Carla Dias', phone: '11987654321' }),
      base({ id: 'b', name: 'carla  DIAS', phone: '11987654321' }),
      base({ id: 'c', name: 'Carla Días' }),
      base({ id: 'x', name: 'Paulo Reis', phone: '11911112222' }),
      base({ id: 'y', name: 'Paulo Reis', phone: '11911112222' }),
    ]);
    expect(grupos.map(g => [g.strength, g.customers.map(c => c.id).sort()])).toEqual([
      ['forte', ['a', 'b']],
      ['forte', ['x', 'y']],
      ['fraco', ['a', 'b', 'c']],
    ]);
    expect(grupos[2].reasons).toEqual(['name']);
  });

  it('sem nada em comum, nenhum grupo', () => {
    expect(groupDuplicates([
      base({ id: 'a', name: 'Ana Souza', phone: '11987654321' }),
      base({ id: 'b', name: 'Bia Souza', phone: '11987654322' }),
    ])).toEqual([]);
  });
});

describe('linha do tempo — página e cursor', () => {
  it('o cursor mantém o formato da history do crediário', () => {
    const c = encodeCursor('2026-09-01T10:00:00.123Z', '0b1c3a0e-1111-4222-8333-444455556666');
    expect(Buffer.from(c, 'base64').toString()).toBe('2026-09-01T10:00:00.123Z|0b1c3a0e-1111-4222-8333-444455556666');
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-09-01T10:00:00.123Z', id: '0b1c3a0e-1111-4222-8333-444455556666' });
    expect(decodeCursor('bGl4bw==')).toBeNull();
  });

  it('chave derivada é um uuid estável e distinta por tipo', () => {
    const id = '0b1c3a0e-1111-4222-8333-444455556666';
    expect(derivedKey('compra', id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(derivedKey('compra', id)).toBe(derivedKey('compra', id));
    expect(derivedKey('compra', id)).not.toBe(derivedKey('cancelamento', id));
  });

  it('ordena por instante e, no empate, pela chave — ambos decrescentes', () => {
    const ev = (key, at) => ({ key, at, type: 't' });
    const { page, hasMore } = mergePage([
      [ev('aaaaaaaa-0000-0000-0000-000000000000', '2026-09-01T10:00:00.000Z')],
      [ev('bbbbbbbb-0000-0000-0000-000000000000', '2026-09-01T10:00:00.000Z'),
        ev('cccccccc-0000-0000-0000-000000000000', '2026-08-01T10:00:00.000Z')],
      [ev('dddddddd-0000-0000-0000-000000000000', new Date('2026-09-02T00:00:00.000Z'))],
    ], 3);
    expect(page.map(e => e.key[0])).toEqual(['d', 'b', 'a']);
    expect(hasMore).toBe(true);
    expect(page[0].at).toBe('2026-09-02T00:00:00.000Z');
  });

  it('parâmetros: limite com teto, tipos validados, cursor inválido é 400', () => {
    expect(parseTimelineQuery({}).limit).toBe(30);
    expect(parseTimelineQuery({ limit: '500' }).limit).toBe(100);
    expect(parseTimelineQuery({ types: 'compra, nota,compra' }).types).toEqual(['compra', 'nota']);
    expect(() => parseTimelineQuery({ types: 'compra,venda' })).toThrow(/types invalido/);
    try {
      parseTimelineQuery({ cursor: 'zzz' });
      throw new Error('devia falhar');
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });
});
