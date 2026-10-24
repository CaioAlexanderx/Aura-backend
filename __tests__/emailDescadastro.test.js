// ============================================================
// AURA. — Descadastro do relatório semanal e QR do Pix (tq-74/tq-77, 24/10/2026)
//
//   GET  /emails/descadastro/:token  página de confirmação, NÃO desliga
//   POST /emails/descadastro/:token  desliga (botão da página e one-click
//                                    do RFC 8058) e grava em audit_log
//   token adulterado ou de outro tipo: 404, nada muda
//   consolidado (grupo): desliga todas as empresas do dono
//   GET  /emails/pix-qr/:token.png   PNG, carregável de outro domínio
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const links = require('../src/services/emailLinks');
const { desligarTipoDeEmail } = require('../src/services/emailPreferencias');

const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILIAL = 'aaaaaaaa-0000-4000-8000-000000000002';

function app() {
  const a = express();
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/emails', require('../src/routes/emailPublico'));
  return a;
}

let escritas;
function ligarBanco({ empresas = [{ id: EMP, weekly_report_enabled: true }] } = {}) {
  escritas = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT COALESCE(trade_name, legal_name) AS loja')) return { rows: [{ loja: 'Finesse' }] };
    if (s.startsWith('SELECT id, weekly_report_enabled FROM companies WHERE id = $1')) {
      return { rows: empresas.filter((e) => e.id === params[0]) };
    }
    if (s.startsWith('SELECT c.id, c.weekly_report_enabled FROM companies c JOIN companies p')) return { rows: empresas };
    if (s.startsWith('UPDATE companies SET weekly_report_enabled = false')) {
      escritas.push({ s, params });
      return { rows: params[0].map((id) => ({ id })) };
    }
    if (s.startsWith('INSERT INTO audit_log')) { escritas.push({ s, params }); return { rows: [] }; }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ligarBanco();
});
afterEach(() => jest.restoreAllMocks());

describe('descadastro', () => {
  test('o link do e-mail aponta para a API e o token traz empresa e tipo', () => {
    const link = links.linkDescadastro(EMP, 'relatorio', {}, { ...process.env, API_URL: 'https://api.x.test/api/v1/' });
    expect(link).toMatch(/^https:\/\/api\.x\.test\/api\/v1\/emails\/descadastro\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const t = link.split('/').pop();
    expect(links.lerTokenDescadastro(t)).toEqual({ companyId: EMP, tipo: 'relatorio', grupo: false });
    expect(links.cabecalhosDescadastro(link)).toEqual({
      'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  test('GET mostra a confirmação e não desliga nada', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const r = await request(app()).get('/emails/descadastro/' + t);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Parar de receber o relatório semanal?');
    expect(r.text).toContain('A Finesse deixa');
    expect(r.text).toContain('<form method="post"');
    expect(escritas).toHaveLength(0);
  });

  test('POST one-click (RFC 8058): desliga, grava audit_log e responde curto', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const r = await request(app()).post('/emails/descadastro/' + t)
      .type('form').send('List-Unsubscribe=One-Click');
    expect(r.status).toBe(200);
    expect(r.text).toBe('OK');
    expect(escritas[0].params).toEqual([[EMP]]);
    const audit = escritas.find((e) => e.s.startsWith('INSERT INTO audit_log'));
    expect(audit.s).toContain("'email.descadastro'");
    expect(JSON.parse(audit.params[2])).toMatchObject({ tipo: 'relatorio', origem: 'one_click' });
  });

  test('POST da página: desliga e mostra "Pronto"', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const r = await request(app()).post('/emails/descadastro/' + t).type('form').send('');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Você não vai mais receber o relatório semanal por e-mail.');
    expect(escritas.filter((e) => e.s.startsWith('UPDATE'))).toHaveLength(1);
  });

  test('token adulterado, de outro tipo ou de QR: 404 e nada muda', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const adulterado = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    const outroTipo = links.tokenDescadastro(EMP, 'novidades');
    const qr = links.linkQrDoPix('PIX').split('/').pop().replace('.png', '');
    for (const tk of [adulterado, outroTipo, qr, 'lixo']) {
      expect((await request(app()).post('/emails/descadastro/' + tk).type('form').send('List-Unsubscribe=One-Click')).status).toBe(404);
      expect((await request(app()).get('/emails/descadastro/' + tk)).status).toBe(404);
    }
    expect(escritas).toHaveLength(0);
  });

  test('já desligado: não grava de novo', async () => {
    ligarBanco({ empresas: [{ id: EMP, weekly_report_enabled: false }] });
    const r = await desligarTipoDeEmail(db, EMP, 'relatorio');
    expect(r).toEqual({ ok: true, desligadas: [], jaEstava: true });
    expect(escritas).toHaveLength(0);
  });

  test('consolidado (grupo): desliga todas as empresas do dono que recebiam', async () => {
    ligarBanco({ empresas: [{ id: EMP, weekly_report_enabled: true }, { id: FILIAL, weekly_report_enabled: true }] });
    const r = await desligarTipoDeEmail(db, EMP, 'relatorio', { grupo: true });
    expect(r.desligadas).toEqual([EMP, FILIAL]);
    expect(escritas.filter((e) => e.s.startsWith('INSERT INTO audit_log'))).toHaveLength(2);
  });
});

describe('QR do Pix', () => {
  test('desenha o PNG do copia e cola, com CORP cross-origin', async () => {
    const link = links.linkQrDoPix('00020126580014br.gov.bcb.pix');
    const r = await request(app()).get('/emails/pix-qr/' + link.split('/').pop());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.body.slice(1, 4).toString()).toBe('PNG');
  });

  test('token inválido: 404', async () => {
    expect((await request(app()).get('/emails/pix-qr/abc.png')).status).toBe(404);
    const d = links.tokenDescadastro(EMP, 'relatorio');
    expect((await request(app()).get('/emails/pix-qr/' + d + '.png')).status).toBe(404);
  });
});
