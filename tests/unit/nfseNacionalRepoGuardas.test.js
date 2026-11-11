// ============================================================
// NFS-e Nacional — guardas do SQL do repo (11/11/2026), com db mockado.
// O SQL de verdade roda em __tests__/nfseNacional.banco.test.js (11–15);
// aqui fica o contrato que não pode voltar atrás:
//   • gravarAutorizada: WHERE com status aberto e sem DPS_NUMERO_JA_USADO;
//     sem linha afetada não lança e devolve a nota atual;
//   • provider_response sempre mesclado (||), em TODO UPDATE do módulo;
//   • atualizarXmlNfse só em autorizada/cancelada.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const repo = require('../../src/services/nfseNacional/repo');

const dbCom = (...respostas) => {
  const q = jest.fn();
  for (const r of respostas) q.mockResolvedValueOnce(r);
  return { query: q };
};

describe('gravarAutorizada', () => {
  test('o UPDATE só vale para nota aberta e sem DPS_NUMERO_JA_USADO (error_codes e prefixo do rejection_reason)', async () => {
    const db = dbCom({ rows: [{ id: 'n1', status: 'autorizada' }] });
    const r = await repo.gravarAutorizada(db, 'n1', { chaveAcesso: '1'.repeat(50), nfseXml: '<NFSe/>' });
    expect(r).toEqual({ gravada: true, nota: { id: 'n1', status: 'autorizada' } });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$9\s+AND status IN \('pendente', 'erro'\)/);
    expect(sql).toContain(`@> '[{"codigo":"DPS_NUMERO_JA_USADO"}]'::jsonb`);
    expect(sql).toContain("NOT LIKE 'DPS\\_NUMERO\\_JA\\_USADO%'");
    expect(sql).toContain("provider_response = COALESCE(provider_response, '{}'::jsonb) || $8::jsonb");
    expect(params[8]).toBe('n1');
  });

  test('sem linha afetada: não lança, devolve a nota como está', async () => {
    const atual = { id: 'n1', status: 'erro', error_codes: [{ codigo: 'DPS_NUMERO_JA_USADO' }] };
    const db = dbCom({ rows: [], rowCount: 0 }, { rows: [atual] });
    const r = await repo.gravarAutorizada(db, 'n1', { chaveAcesso: '1'.repeat(50), nfseXml: '<NFSe/>' });
    expect(r).toEqual({ gravada: false, nota: atual });
    expect(db.query.mock.calls[1][0]).toMatch(/^SELECT .* FROM nfse WHERE id = \$1$/s);
  });
});

test('atualizarXmlNfse: só nota autorizada ou cancelada', async () => {
  const db = dbCom({ rows: [] });
  await repo.atualizarXmlNfse(db, 'n1', '<NFSe/>');
  expect(db.query.mock.calls[0][0]).toMatch(/WHERE id = \$2 AND status IN \('autorizada', 'cancelada'\)/);
});

test('gravarRejeitada e anexarEvidencia mesclam provider_response', async () => {
  const db = dbCom({ rows: [] }, { rows: [] });
  await repo.gravarRejeitada(db, 'n1', { texto: 'x', erros: [] });
  await repo.anexarEvidencia(db, 'n1', { a: 1 });
  for (const [sql] of db.query.mock.calls) expect(sql).toMatch(/provider_response = COALESCE\(provider_response, '\{\}'::jsonb\) \|\| \$\d::jsonb/);
});

test('nenhum UPDATE do módulo nfseNacional sobrescreve provider_response', () => {
  const dir = path.join(__dirname, '../../src/services/nfseNacional');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const atribuicoes = src.match(/provider_response\s*=\s*[^\n]*/g) || [];
    for (const a of atribuicoes) expect(`${f}: ${a}`).toMatch(/COALESCE\(provider_response, '\{\}'::jsonb\) \|\|/);
  }
});
