// ============================================================
// Frente da empresa — services/segment.js (05/10/2026)
// Sugestao por CNAE e applySegment (o que cada frente liga).
// ============================================================
const {
  suggestSegmentFromCnae, normalizeCnae, applySegment, SEGMENTS,
} = require('../src/services/segment');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

describe('suggestSegmentFromCnae', () => {
  test.each([
    ['4774-1/00', 'otica'],
    ['4744-0/01', 'matcon'],
    ['4744-0/02', 'matcon'],
    ['4744-0/03', 'matcon'],
    ['4744-0/04', 'matcon'],
    ['4744-0/05', 'matcon'],
    ['4744-0/06', 'matcon'],
    ['4744-0/99', 'matcon'],
    ['4741-5/00', 'matcon'],
    ['4742-3/00', 'matcon'],
    ['4743-1/00', 'matcon'],
    ['9511-8/00', 'assistencia'],
    ['9512-6/00', 'assistencia'],
    ['9521-5/00', 'assistencia'],
    ['4752-1/00', 'assistencia'],
    ['1813-0/01', 'studio'],
    ['1813-0/99', 'studio'],
    ['1340-5/01', 'studio'],
    ['4781-4/00', 'varejo'],
    ['4782-2/01', 'varejo'],
  ])('%s -> %s', (cnae, esperado) => {
    expect(suggestSegmentFromCnae(cnae)).toBe(esperado);
  });

  test('aceita so digitos, pontuacao variada, numero e o objeto da consulta', () => {
    expect(suggestSegmentFromCnae('4774100')).toBe('otica');
    expect(suggestSegmentFromCnae('47.74-1-00')).toBe('otica');
    expect(suggestSegmentFromCnae(4774100)).toBe('otica');
    expect(suggestSegmentFromCnae({ code: '4774100', description: 'x' })).toBe('otica');
  });

  test('desconhecido, vazio ou malformado -> null', () => {
    expect(suggestSegmentFromCnae('6201-5/01')).toBeNull(); // software
    expect(suggestSegmentFromCnae('')).toBeNull();
    expect(suggestSegmentFromCnae(null)).toBeNull();
    expect(suggestSegmentFromCnae('4774')).toBeNull(); // so a classe, sem subclasse
    expect(suggestSegmentFromCnae('1340-5/02')).toBeNull(); // tinturaria nao e personalizados
  });

  test('principal decide; secundarios so contam quando o principal e desconhecido', () => {
    expect(suggestSegmentFromCnae('4781-4/00', [{ code: '9512600' }])).toBe('varejo');
    expect(suggestSegmentFromCnae('6201-5/01', [{ code: '4781400' }, { code: '9512600' }])).toBe('assistencia');
    expect(suggestSegmentFromCnae('6201-5/01', [{ code: '4781400' }])).toBe('varejo');
    expect(suggestSegmentFromCnae('6201-5/01', [{ code: '6202300' }])).toBeNull();
  });

  test('normalizeCnae exige 7 digitos', () => {
    expect(normalizeCnae('4774-1/00')).toBe('4774100');
    expect(normalizeCnae('47741')).toBeNull();
    expect(normalizeCnae({})).toBeNull();
  });

  test('lista de frentes', () => {
    expect(SEGMENTS).toEqual(['varejo', 'matcon', 'otica', 'assistencia', 'studio', 'outro']);
  });
});

describe('applySegment', () => {
  const C = 'c1';

  test.each([
    ['matcon', 'matcon_enabled'],
    ['otica', 'otica_enabled'],
    ['assistencia', 'os_enabled'],
  ])('%s liga %s e grava segment/source', async (segment, flag) => {
    const db = fakeSegmentDb({ companies: { [C]: {} } });
    const out = await applySegment(db.client, C, { segment, source: 'user' });
    expect(db.state.companies[C].segment).toBe(segment);
    expect(db.state.companies[C].segment_source).toBe('user');
    expect(db.state.companies[C].pdv_settings[flag]).toBe(true);
    expect(out.flags[flag]).toBe(true);
  });

  test('varejo e outro nao ligam nada', async () => {
    for (const segment of ['varejo', 'outro']) {
      const db = fakeSegmentDb({ companies: { [C]: {} } });
      const out = await applySegment(db.client, C, { segment });
      expect(db.state.companies[C].pdv_settings).toEqual({});
      expect(out.flags).toEqual({ matcon_enabled: false, otica_enabled: false, os_enabled: false, studio_enabled: false });
    }
  });

  test('extras os liga os_enabled junto da frente', async () => {
    const db = fakeSegmentDb({ companies: { [C]: {} } });
    await applySegment(db.client, C, { segment: 'otica', extras: ['os'] });
    expect(db.state.companies[C].pdv_settings).toEqual({ otica_enabled: true, os_enabled: true });
  });

  test('merge: nao apaga chaves que ja estavam em pdv_settings nem desliga nada', async () => {
    const db = fakeSegmentDb({ companies: { [C]: { pdv_settings: { os_enabled: true, label_size: '30x25' } } } });
    await applySegment(db.client, C, { segment: 'matcon' });
    expect(db.state.companies[C].pdv_settings).toEqual({ os_enabled: true, label_size: '30x25', matcon_enabled: true });
  });

  test('studio ativa a vertical e studio_enabled no plano negocio', async () => {
    const db = fakeSegmentDb({ companies: { [C]: { plan: 'negocio' } } });
    const out = await applySegment(db.client, C, { segment: 'studio' });
    expect(db.state.companies[C].vertical_active).toBe('studio');
    expect(db.state.companies[C].pdv_settings.studio_enabled).toBe(true);
    expect(out.vertical_active).toBe('studio');
  });

  test('studio no essencial -> 409 STUDIO_PLAN_REQUIRED e nada gravado', async () => {
    const db = fakeSegmentDb({ companies: { [C]: { plan: 'essencial' } } });
    await expect(applySegment(db.client, C, { segment: 'studio' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'STUDIO_PLAN_REQUIRED' });
    expect(db.state.companies[C].vertical_active).toBeNull();
    expect(db.state.companies[C].segment).toBeNull();
  });

  test('disable so com source staff', async () => {
    const db = fakeSegmentDb({ companies: { [C]: { pdv_settings: { os_enabled: true } } } });
    await expect(applySegment(db.client, C, { segment: 'varejo', disable: ['os'], source: 'user' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(db.state.companies[C].pdv_settings.os_enabled).toBe(true);
  });

  test('extras fora da whitelist -> 400', async () => {
    const db = fakeSegmentDb({ companies: { [C]: {} } });
    await expect(applySegment(db.client, C, { segment: 'varejo', extras: ['studio'] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('segment invalido -> 400', async () => {
    const db = fakeSegmentDb({ companies: { [C]: {} } });
    await expect(applySegment(db.client, C, { segment: 'odonto' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
