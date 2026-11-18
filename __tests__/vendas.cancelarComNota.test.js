// ============================================================
// AURA. — Cancelar venda com nota autorizada (17/11/2026)
// Card b-troca-prazo-nfce.
//
// Antes: cancelar a venda não cancelava a NFC-e nem avisava a lojista.
// Agora o POST /sales/:id/cancel devolve `nota` e, com `cancelar_nota: true`
// e DENTRO do prazo da UF, cancela a nota na SEFAZ depois do COMMIT, pelo
// mesmo serviço do POST /nfce/:id/cancel. Fora do prazo não tenta: avisa
// com o caminho (devolução). Sem o campo, nada fiscal acontece.
// SEFAZ: mock (sefazSp.cancelNfce). Dados fictícios.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('../src/services/sefazSp', () => ({ cancelNfce: jest.fn() }));
jest.mock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const sefazSp = require('../src/services/sefazSp');

const CID = 'c0000000-0000-0000-0000-0000000000c1';
const SALE = 'a0000000-0000-0000-0000-000000000001';
const NOTA = 'e0000000-0000-0000-0000-000000000001';
// cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) DV(1)
const chave = (cuf) => `${cuf}2611` + '11222333000181' + '65' + '002' + '000000900' + '1' + '12345678' + '0';
const minutosAtras = (m) => new Date(Date.now() - m * 60000).toISOString();
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

let nota; // nfce_emissions da venda (ou null)
let sqlsTx;

function instalar() {
  sqlsTx = [];
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      sqlsTx.push(s);
      if (/^SELECT id, total_amount, status, COALESCE\(type,'sale'\) AS type[, ].*FROM sales/.test(s)) {
        return { rows: [{ id: SALE, total_amount: '100.00', status: 'completed', type: 'sale' }] };
      }
      if (/FROM nfce_emissions ne LEFT JOIN nfce_config nc ON nc\.company_id = ne\.company_id WHERE ne\.sale_id = \$1 AND ne\.tipo IN/.test(s)) {
        return { rows: nota ? [{ ...nota }] : [] };
      }
      if (/^SELECT si\.product_id, si\.variant_id, si\.quantity FROM sale_items/.test(s)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    }),
  };
  db.connect.mockResolvedValue(client);
  // Pool: o serviço de cancelamento da nota (depois do COMMIT).
  db.query.mockImplementation(async (sql, params) => {
    const s = norm(sql);
    if (/^SELECT \* FROM nfce_emissions WHERE id=\$1 AND company_id=\$2 AND xml_signed IS NOT NULL/.test(s)) {
      return { rows: nota && params[0] === nota.id ? [{ ...nota, company_id: CID, xml_signed: '<NFe/>', protocolo: '135260000000001' }] : [] };
    }
    if (/^SELECT \* FROM nfce_config WHERE company_id=\$1/.test(s)) return { rows: [{ company_id: CID, uf: nota && nota.config_uf, ambiente: 'homologacao' }] };
    if (/^UPDATE nfce_emissions SET status='cancelada'/.test(s)) return { rows: [{ ...nota, status: 'cancelada' }] };
    return { rows: [] };
  });
}

function app() {
  const router = require('../src/routes/sales');
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
  a.use('/companies/:id/sales', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return a;
}
const APP = app();
const cancelar = (body = {}) => request(APP).post(`/companies/${CID}/sales/${SALE}/cancel`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  nota = null;
  instalar();
  sefazSp.cancelNfce.mockResolvedValue({ sucesso: true, cStat: '135', protocoloEvento: '135260000009999' });
});

describe('cancelar venda — NFC-e dentro do prazo', () => {
  test('com cancelar_nota: a venda cancela e a NFC-e também, depois do COMMIT', async () => {
    nota = { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave('35'), authorized_at: minutosAtras(10), config_uf: 'SP' };
    const r = await cancelar({ reason: 'cliente desistiu', cancelar_nota: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.nota).toMatchObject({ id: NOTA, situacao: 'cancelada', uf: 'SP', prazo_minutos: 30 });
    expect(r.body.nota.mensagem).toMatch(/também foi cancelada na SEFAZ/);
    expect(sefazSp.cancelNfce).toHaveBeenCalledTimes(1);
    const just = sefazSp.cancelNfce.mock.calls[0][0].justificativa;
    expect(just).toBe('Venda cancelada pela loja: cliente desistiu');
    expect(just.length).toBeGreaterThanOrEqual(15);
    // A nota sai depois do COMMIT da venda.
    expect(sqlsTx).toContain('COMMIT');
  });

  test('sem cancelar_nota: nada fiscal acontece, só o aviso de que a nota continua', async () => {
    nota = { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave('35'), authorized_at: minutosAtras(10), config_uf: 'SP' };
    const r = await cancelar({ reason: '' });
    expect(r.status).toBe(200);
    expect(r.body.nota).toMatchObject({ situacao: 'mantida' });
    expect(r.body.nota.mensagem).toMatch(/continua autorizada/);
    expect(sefazSp.cancelNfce).not.toHaveBeenCalled();
  });

  test('SEFAZ recusa: a venda fica cancelada e a resposta conta, com gentileza', async () => {
    nota = { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave('35'), authorized_at: minutosAtras(10), config_uf: 'SP' };
    sefazSp.cancelNfce.mockResolvedValue({ sucesso: false, cStat: '999', xMotivo: 'Rejeição de teste' });
    const r = await cancelar({ cancelar_nota: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.nota).toMatchObject({ situacao: 'nao_cancelada' });
    expect(r.body.nota.mensagem).toMatch(/continua autorizada/);
  });
});

describe('cancelar venda — NFC-e fora do prazo', () => {
  test.each([['2 h', 120], ['30 h', 30 * 60]])('%s: não tenta cancelar e mostra o caminho da devolução', async (_r, m) => {
    nota = { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave('35'), authorized_at: minutosAtras(m), config_uf: 'SP' };
    const r = await cancelar({ cancelar_nota: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.nota).toMatchObject({ situacao: 'fora_do_prazo', caminho: 'devolucao' });
    expect(r.body.nota.mensagem).toMatch(/NF-e de devolução/);
    expect(sefazSp.cancelNfce).not.toHaveBeenCalled();
  });
});

describe('cancelar venda — as UFs', () => {
  test.each([['SP', '35'], ['AP', '16'], ['RJ', '33'], ['MG', '31']])('%s: 10 min cancela; 40 min fica', async (uf, cuf) => {
    nota = { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave(cuf), authorized_at: minutosAtras(10), config_uf: uf };
    const dentro = await cancelar({ cancelar_nota: true });
    expect(dentro.body.nota).toMatchObject({ uf, situacao: 'cancelada', prazo_minutos: 30 });

    jest.clearAllMocks();
    nota = { ...nota, authorized_at: minutosAtras(40) };
    instalar();
    const fora = await cancelar({ cancelar_nota: true });
    expect(fora.body.nota).toMatchObject({ uf, situacao: 'fora_do_prazo' });
    expect(sefazSp.cancelNfce).not.toHaveBeenCalled();
  });
});

describe('cancelar venda — sem nota', () => {
  test('resposta como antes, nota null', async () => {
    const r = await cancelar({ cancelar_nota: true });
    expect(r.status).toBe(200);
    expect(r.body.nota).toBeNull();
    expect(sefazSp.cancelNfce).not.toHaveBeenCalled();
  });
});

describe('detalhe da venda — prazo da nota à vista', () => {
  test('nota autorizada traz cancelamento { uf, prazo_minutos, ate, dentro }', async () => {
    const aut = minutosAtras(10);
    db.query.mockImplementation(async (sql) => {
      const s = norm(sql);
      if (/FROM sales s LEFT JOIN customers c/.test(s)) return { rows: [{ id: SALE, company_id: CID, total_amount: '100.00', status: 'completed', type: 'sale', created_at: aut }] };
      if (/FROM nfce_emissions ne LEFT JOIN nfce_config nc ON nc\.company_id = ne\.company_id WHERE ne\.sale_id = \$1 ORDER BY/.test(s)) {
        return { rows: [
          { id: NOTA, tipo: 'nfce', status: 'autorizada', numero: 900, chave_acesso: chave('33'), authorized_at: aut, config_uf: 'RJ' },
          { id: 'outra', tipo: 'nfce', status: 'rejeitada', numero: 899, chave_acesso: null, authorized_at: null, config_uf: 'RJ' },
        ] };
      }
      return { rows: [] };
    });
    const r = await request(APP).get(`/companies/${CID}/sales/${SALE}`);
    expect(r.status).toBe(200);
    expect(r.body.fiscal[0].cancelamento).toMatchObject({ uf: 'RJ', prazo_minutos: 30, dentro: true });
    expect(r.body.fiscal[1].cancelamento).toBeNull();
  });
});
