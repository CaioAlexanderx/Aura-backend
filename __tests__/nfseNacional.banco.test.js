// ============================================================
// AURA. — NFS-e Nacional (migration 429) — Postgres REAL, Sefin simulado.
//
//   1. a migration 429 deixa as tabelas antigas funcionando (insert do
//      fluxo de RPS) e aceita a nota nacional sem RPS nem tomador;
//   2. emitir de ponta a ponta: A1 do cofre (company_certificates, cifrado
//      de verdade), número reservado em nfse_config, nota autorizada;
//   3. idempotência no banco: a mesma chave não cria segunda nota nem
//      gasta número; a reserva concorrente (UNIQUE) devolve o número;
//   4. timeout → pendente; retomada usa o MESMO número;
//   5. cancelamento grava o evento;
//   6–8. migration 441: nota de teste na série 49999 com contador próprio
//      (a numeração da loja não anda) e o resultado gravado na config.
//   9–10. migration 443: a consulta da DPS devolve a NFS-e de OUTRO emissor
//      (incidente de 10/11/2026) → nota em erro DPS_NUMERO_JA_USADO, nada
//      autorizado, evidência em provider_response, conflito na config; a
//      venda seguinte não gasta número até a loja conferir.
//
// Mesmo padrão de caixa.movimentos.banco.test.js: tudo numa transação
// revertida no afterAll; BEGIN/COMMIT/ROLLBACK do serviço viram SAVEPOINT.
// ============================================================
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let db;

const userId = uuid();
const companyId = uuid();

function cnpjValido() {
  const base = String(Math.floor(Math.random() * 1e8)).padStart(8, '0') + '0001';
  const dv = (s, w) => { const r = s.split('').reduce((acc, d, i) => acc + Number(d) * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + d1 + d2;
}
const CNPJ = cnpjValido();
const CHAVE = ('3524402' + '2' + '2' + CNPJ + '0000000000001' + '2611' + '000000001' + '9').slice(0, 50);
const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const json = (status, body) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>1</nNFSe><cStat>100</cStat><dhProc>2026-11-09T10:00:05-03:00</dhProc><valores><vLiq>199.90</vLiq></valores></infNFSe></NFSe>`;

let plano = {};
const transport = async (req) => {
  const p = new URL(req.url).pathname;
  if (req.method === 'POST' && p.endsWith('/nfse')) return (plano.postDps || (() => json(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: gz(NFSE_XML) })))();
  if (req.method === 'GET' && p.includes('/dps/')) return (plano.getDps || (() => json(404, {})))();
  if (req.method === 'GET' && /\/nfse\/\d{50}$/.test(p)) return (plano.getNfse || (() => json(404, {})))();
  if (req.method === 'POST' && p.endsWith('/eventos')) return json(201, { eventoXmlGZipB64: gz('<evento>ok</evento>') });
  return json(404, {});
};
const ctx = { transport: (r) => transport(r), retry: { attempts: 1, baseDelayMs: 0 } };
const NOTA = { descricao: 'Licença de uso do sistema - novembro/2026', valor: 199.9 };

let nacional;
let repo;

beforeAll(async () => {
  process.env.NFSE_NACIONAL_ENABLED = 'true';
  process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN') { sp += 1; return client.query(`SAVEPOINT nac_${sp}`); }
      if (s === 'COMMIT') return client.query(`RELEASE SAVEPOINT nac_${sp}`);
      if (s === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT nac_${sp}`);
      return client.query(sql, params);
    },
    release: () => {},
  }));

  nacional = require('../src/services/nfseNacional');
  repo = require('../src/services/nfseNacional/repo');
  const { saveCertificate } = require('../src/services/sefazSp/certStore');
  const { gerarA1 } = require('../tests/helpers/certA1Teste');
  const a1 = gerarA1({ cnpj: CNPJ });

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture NFS-e')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, cnpj) VALUES ($1, $2, 'Fixture Serviços', $3)`,
    [companyId, userId, CNPJ]
  );
  await saveCertificate(db, companyId, a1.pfx, a1.senha);
  await client.query(
    `INSERT INTO nfse_config (company_id, provider, ambiente, is_active, municipio_ibge, ctribnac_padrao,
                              op_simp_nac, reg_ap_trib_sn, p_tot_trib_sn, serie)
     VALUES ($1, 'nacional', 'producao_restrita', true, '3524402', '010501', 3, 1, 6.00, '1')`,
    [companyId]
  );
});

afterAll(async () => {
  delete process.env.NFSE_NACIONAL_ENABLED;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const proximo = async () => Number((await client.query('SELECT next_dps_number FROM nfse_config WHERE company_id = $1', [companyId])).rows[0].next_dps_number);
const contar = async () => Number((await client.query('SELECT count(*) FROM nfse WHERE company_id = $1', [companyId])).rows[0].count);

describe('NFS-e nacional — banco real', () => {
  test('1. migration 429: colunas novas, NOT NULL relaxados, ambiente cabe producao_restrita, fluxo antigo de RPS intacto', async () => {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'nfse' AND column_name IN ('rps_number', 'recipient_name', 'idempotency_key', 'dps_number', 'chave_acesso', 'xml_dps')`
    );
    const m = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(m).toEqual({ rps_number: 'YES', recipient_name: 'YES', idempotency_key: 'YES', dps_number: 'YES', chave_acesso: 'YES', xml_dps: 'YES' });
    const { rows: rps } = await client.query('SELECT nfse_next_rps($1) AS n', [companyId]);
    const antigo = await client.query(
      `INSERT INTO nfse (company_id, rps_number, rps_serie, recipient_name, service_code, service_description, service_amount, iss_rate, iss_value)
       VALUES ($1, $2, '1', 'Tomador', '1.05', 'Serviço', 10, 2, 0.2) RETURNING id`,
      [companyId, rps[0].n]
    );
    expect(antigo.rows[0].id).toBeDefined();
    await client.query('DELETE FROM nfse WHERE id = $1', [antigo.rows[0].id]);
  });

  test('2. emite com o A1 do cofre: nota autorizada, número 1 reservado, XML gravado', async () => {
    const r = await nacional.emitir(db, { companyId, idempotencyKey: 'pay_1', nota: NOTA }, ctx);
    expect(r.nota).toMatchObject({ status: 'autorizada', chave_acesso: CHAVE, nfse_number: '1', dps_serie: '1', provider: 'nacional', ambiente: 'producao_restrita' });
    expect(String(r.nota.dps_number)).toBe('1');
    expect(await proximo()).toBe(2);
    const { rows } = await client.query('SELECT xml_dps, xml_nfse, transmitted_at, rps_number, recipient_name FROM nfse WHERE id = $1', [r.nota.id]);
    expect(rows[0].xml_dps).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><DPS /);
    expect(rows[0].xml_nfse).toBe(NFSE_XML);
    expect(rows[0].transmitted_at).not.toBeNull();
    expect(rows[0].rps_number).toBeNull();
    expect(rows[0].recipient_name).toBeNull();
  });

  test('3. mesma chave: replay, nenhuma nota nova, nenhum número gasto; reserva concorrente devolve o número', async () => {
    const antes = await contar();
    const r = await nacional.emitir(db, { companyId, idempotencyKey: 'pay_1', nota: NOTA }, ctx);
    expect(r.replay).toBe(true);
    expect(await contar()).toBe(antes);
    expect(await proximo()).toBe(2);

    const entrada = nacional.montarEntrada({
      nota: NOTA, config: (await client.query('SELECT * FROM nfse_config WHERE company_id = $1', [companyId])).rows[0],
      company: { cnpj: CNPJ }, tpAmb: 2, dhEmi: new Date(),
    });
    const corrida = await repo.reservar(db, { companyId, key: 'pay_1', fp: 'x', entrada, nota: NOTA, ambiente: 'producao_restrita' });
    expect(corrida).toEqual({ corrida: true });
    expect(await proximo()).toBe(2); // o UPDATE da reserva voltou junto
    expect(await contar()).toBe(antes);
  });

  test('4. timeout: nota pendente; retomada com a mesma chave usa o MESMO número', async () => {
    plano.postDps = () => { throw new Error('timeout após 30000ms'); };
    const r1 = await nacional.emitir(db, { companyId, idempotencyKey: 'pay_2', nota: NOTA }, ctx);
    expect(r1.aguardando).toBe(true);
    expect(r1.nota.status).toBe('pendente');
    expect(String(r1.nota.dps_number)).toBe('2');

    // último dígito do nNFSe (posição 35): 1 → 2 — outra chave de acesso
    const chave2 = CHAVE.slice(0, 35) + '2' + CHAVE.slice(36);
    expect(chave2).not.toBe(CHAVE);
    plano.postDps = () => json(201, { chaveAcesso: chave2, nfseXmlGZipB64: gz(NFSE_XML.replace(CHAVE, chave2)) });
    const r2 = await nacional.emitir(db, { companyId, idempotencyKey: 'pay_2', nota: NOTA }, ctx);
    expect(r2.nota.status).toBe('autorizada');
    expect(String(r2.nota.dps_number)).toBe('2');
    expect(await proximo()).toBe(3);
    plano = {};
  });

  test('5. cancelamento grava o evento e a situação cancelada', async () => {
    const { rows } = await client.query(`SELECT id FROM nfse WHERE company_id = $1 AND idempotency_key = 'pay_1'`, [companyId]);
    const r = await nacional.cancelar(db, { companyId, nfseId: rows[0].id, cMotivo: 1, xMotivo: 'Fatura emitida em duplicidade' }, ctx);
    expect(r.nota.status).toBe('cancelada');
    const { rows: c } = await client.query('SELECT cancel_event_xml, cancel_reason, cancelled_at FROM nfse WHERE id = $1', [rows[0].id]);
    expect(c[0]).toMatchObject({ cancel_event_xml: '<evento>ok</evento>', cancel_reason: 'Fatura emitida em duplicidade' });
    expect(c[0].cancelled_at).not.toBeNull();
  });
});

// ── migration 441: nota de teste no banco real ──
describe('NFS-e nacional — nota de teste (migration 441), banco real', () => {
  const ultimo = async () => (await client.query(
    `SELECT next_dps_number, teste_next_dps_number, ultimo_teste_status, ultimo_teste_codigo, ultimo_teste_nfse_id, ultimo_teste_em
       FROM nfse_config WHERE company_id = $1`, [companyId])).rows[0];

  test('6. colunas novas sem valor de fábrica: alíquota do retido e respostas nulas, contador de teste em 1', async () => {
    const { rows } = await client.query(
      `SELECT aliquota_iss_retencao_sn, cliente_retem_iss, prefeitura_cadastro_confirmado, serie_confirmada_em, teste_next_dps_number
         FROM nfse_config WHERE company_id = $1`, [companyId]);
    expect(rows[0]).toEqual({
      aliquota_iss_retencao_sn: null, cliente_retem_iss: null, prefeitura_cadastro_confirmado: null,
      serie_confirmada_em: null, teste_next_dps_number: '1',
    });
    // CHECK 1,80 a 5,00 (savepoint: o erro não derruba a transação do arquivo)
    await client.query('SAVEPOINT ck');
    await expect(client.query('UPDATE nfse_config SET aliquota_iss_retencao_sn = 1.5 WHERE company_id = $1', [companyId]))
      .rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT ck');
  });

  test('7. teste autorizado: série 49999 nº 1 em produção restrita, numeração da loja intacta, resultado gravado', async () => {
    const antes = await ultimo();
    const chave3 = CHAVE.slice(0, 35) + '3' + CHAVE.slice(36);
    plano.postDps = () => json(201, { chaveAcesso: chave3, nfseXmlGZipB64: gz(NFSE_XML.replace(CHAVE, chave3)) });
    const r = await nacional.emitirTeste(db, { companyId, idempotencyKey: 'clique-1' }, ctx);
    plano = {};
    expect(r.resultado.status).toBe('ok');
    expect(r.nota).toMatchObject({ status: 'autorizada', dps_serie: '49999', ambiente: 'producao_restrita', idempotency_key: 'teste:clique-1' });
    expect(String(r.nota.dps_number)).toBe('1');
    const depois = await ultimo();
    expect(depois.next_dps_number).toBe(antes.next_dps_number);
    expect(depois).toMatchObject({ teste_next_dps_number: '2', ultimo_teste_status: 'ok', ultimo_teste_codigo: null, ultimo_teste_nfse_id: r.nota.id });
    expect(depois.ultimo_teste_em).not.toBeNull();
    const { rows } = await client.query('SELECT source_type FROM nfse WHERE id = $1', [r.nota.id]);
    expect(rows[0].source_type).toBe('teste');
  });

  test('8. teste com E0084: rejeitado, código gravado; o próximo teste usa o nº 2 da série de teste', async () => {
    plano.postDps = () => json(400, { erros: [{ Codigo: 'E0084', Descricao: 'Contribuinte não habilitado no município' }] });
    const r = await nacional.emitirTeste(db, { companyId, idempotencyKey: 'clique-2' }, ctx);
    plano = {};
    expect(r.resultado).toMatchObject({ status: 'rejeitado', passo: 'prefeitura', codigo: 'E0084' });
    expect(String(r.nota.dps_number)).toBe('2');
    expect(await ultimo()).toMatchObject({ teste_next_dps_number: '3', ultimo_teste_status: 'rejeitado', ultimo_teste_codigo: 'E0084' });
  });
});

// ── migration 443: DPS com série/número já usados por outro emissor ──
describe('NFS-e nacional — DPS com número já usado (migration 443), banco real', () => {
  const incidente = require('../tests/fixtures/nfseDpsNumeroJaUsado');
  const conflito = async () => (await client.query(
    `SELECT next_dps_number, dps_conflito_em, dps_conflito_serie, dps_conflito_numero, outro_emissor
       FROM nfse_config WHERE company_id = $1`, [companyId])).rows[0];

  test('9. timeout e a consulta devolve a NFS-e do outro emissor: erro, nada autorizado, evidência à parte, conflito na config', async () => {
    plano.postDps = () => { throw new Error('timeout após 30000ms'); };
    plano.getDps = () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR });
    plano.getNfse = () => json(200, { chaveAcesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nfseXmlGZipB64: gz(incidente.NFSE_DO_OUTRO_EMISSOR) });
    const antes = await proximo();
    const r = await nacional.emitir(db, { companyId, idempotencyKey: 'venda_carimbo', nota: incidente.VENDA_DA_AURA }, ctx);
    plano = {};
    expect(r.nota.status).toBe('erro');
    const { rows } = await client.query(
      `SELECT status, chave_acesso, provider_id, nfse_number, xml_nfse, issued_at, error_codes, rejection_reason,
              provider_response->'nfse_de_outro_emissor' AS ev
         FROM nfse WHERE id = $1`, [r.nota.id]
    );
    expect(rows[0]).toMatchObject({ status: 'erro', chave_acesso: null, provider_id: null, nfse_number: null, xml_nfse: null, issued_at: null });
    expect(rows[0].error_codes[0].codigo).toBe('DPS_NUMERO_JA_USADO');
    expect(rows[0].rejection_reason).toBe(`A série 1 e o número ${antes} da DPS já foram usados por outro emissor desta empresa. `
      + 'Confira na configuração da NFS-e a Série da DPS e o último Número usado e tente de novo.');
    expect(rows[0].ev).toMatchObject({ motivo: 'nfse_de_outra_dps', chave_acesso: incidente.CHAVE_DO_OUTRO_EMISSOR, nNFSe: '1' });
    expect(rows[0].ev.xml_nfse).toBe(incidente.NFSE_DO_OUTRO_EMISSOR);
    const c = await conflito();
    expect(c).toMatchObject({ dps_conflito_serie: '1', dps_conflito_numero: String(antes), next_dps_number: String(antes + 1) });
    expect(c.dps_conflito_em).not.toBeNull();
  });

  test('10. com o conflito aberto, venda nova não gasta número nem cria nota; a mesma chave não reenvia', async () => {
    const antes = await proximo();
    const notas = await contar();
    await expect(nacional.emitir(db, { companyId, idempotencyKey: 'venda_seguinte', nota: NOTA }, ctx))
      .rejects.toMatchObject({ code: 'DPS_NUMERO_JA_USADO' });
    const again = await nacional.emitir(db, { companyId, idempotencyKey: 'venda_carimbo', nota: incidente.VENDA_DA_AURA }, ctx);
    expect(again.replay).toBe(true);
    expect(again.nota.status).toBe('erro');
    expect(await proximo()).toBe(antes);
    expect(await contar()).toBe(notas);
  });
});
