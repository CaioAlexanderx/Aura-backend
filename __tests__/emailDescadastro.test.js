// ============================================================
// AURA. — Descadastro por tipo e QR do Pix (tq-74/tq-77, tq-87/tq-88, 24/10/2026)
//
//   GET  /emails/descadastro/:token  página de confirmação, NÃO desliga
//   POST /emails/descadastro/:token  desliga o tipo do token (botão da página
//                                    e one-click do RFC 8058) em
//                                    company_email_prefs e grava audit_log
//   token adulterado, de tipo desconhecido ou de QR: 404, nada muda
//   consolidado (grupo): desliga todas as empresas do dono
//   GET  /emails/confirmar/:token    confirma endereço extra (tq-87)
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
const END = 'bbbbbbbb-0000-4000-8000-000000000001';

function app() {
  const a = express();
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/emails', require('../src/routes/emailPublico'));
  return a;
}

// company_email_prefs em memória: chave "empresa:tipo" -> ligado. Ausente =
// padrão (ligado).
let escritas;
let prefs;
let empresas;
let enderecos;
function ligarBanco({ lista = [EMP], linhas = {}, ends = [] } = {}) {
  escritas = [];
  prefs = new Map(Object.entries(linhas));
  empresas = lista;
  enderecos = ends;
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT COALESCE(trade_name, legal_name) AS loja')) return { rows: [{ loja: 'Finesse' }] };
    if (s.startsWith('SELECT id FROM companies WHERE id = $1')) {
      return { rows: empresas.includes(params[0]) ? [{ id: params[0] }] : [] };
    }
    if (s.startsWith('SELECT c.id FROM companies c JOIN companies p')) return { rows: empresas.map((id) => ({ id })) };
    if (s.startsWith('INSERT INTO company_email_prefs')) {
      escritas.push({ s, params });
      const [ids, tipo] = params;
      const out = [];
      for (const id of ids) {
        const k = `${id}:${tipo}`;
        if (prefs.get(k) === false) continue;
        prefs.set(k, false);
        out.push({ company_id: id });
      }
      return { rows: out };
    }
    if (s.startsWith('UPDATE companies SET weekly_report_enabled = false')) { escritas.push({ s, params }); return { rows: [] }; }
    if (s.startsWith('INSERT INTO audit_log')) { escritas.push({ s, params }); return { rows: [] }; }
    if (s.startsWith('UPDATE company_email_addresses SET confirmado_em')) {
      const e = enderecos.find((x) => x.id === params[0] && x.company_id === params[1] && x.email === params[2]);
      if (!e) return { rows: [] };
      e.confirmado_em = e.confirmado_em || new Date();
      return { rows: [e] };
    }
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

  test('POST one-click (RFC 8058): desliga na tabela nova, grava audit_log e responde curto', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const r = await request(app()).post('/emails/descadastro/' + t)
      .type('form').send('List-Unsubscribe=One-Click');
    expect(r.status).toBe(200);
    expect(r.text).toBe('OK');
    expect(prefs.get(`${EMP}:relatorio`)).toBe(false);
    const ins = escritas.find((e) => e.s.startsWith('INSERT INTO company_email_prefs'));
    expect(ins.params).toEqual([[EMP], 'relatorio', 'descadastro']);
    // Espelho para um revert do deploy não religar o relatório.
    expect(escritas.some((e) => e.s.startsWith('UPDATE companies SET weekly_report_enabled = false'))).toBe(true);
    const audit = escritas.find((e) => e.s.startsWith('INSERT INTO audit_log'));
    expect(audit.s).toContain("'email.descadastro'");
    expect(JSON.parse(audit.params[2])).toMatchObject({ tipo: 'relatorio', origem: 'one_click' });
  });

  test('POST da página: desliga e mostra "Pronto" com o link de ajustar', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const r = await request(app()).post('/emails/descadastro/' + t).type('form').send('');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Você não vai mais receber o relatório semanal por e-mail.');
    expect(r.text).toContain(`configuracoes?foco=emails&amp;empresa=${EMP}`);
    expect(escritas.filter((e) => e.s.startsWith('INSERT INTO company_email_prefs'))).toHaveLength(1);
  });

  test('cada tipo desliga o tipo certo (novidades, acompanhamento, ajuda, pedido_loja)', async () => {
    for (const tipo of ['novidades', 'acompanhamento', 'ajuda', 'pedido_loja']) {
      const t = links.tokenDescadastro(EMP, tipo);
      const r = await request(app()).post('/emails/descadastro/' + t).type('form').send('List-Unsubscribe=One-Click');
      expect(r.status).toBe(200);
      expect(prefs.get(`${EMP}:${tipo}`)).toBe(false);
    }
    expect(prefs.has(`${EMP}:relatorio`)).toBe(false);
    // Só o relatório espelha em companies.weekly_report_enabled.
    expect(escritas.some((e) => e.s.startsWith('UPDATE companies'))).toBe(false);
  });

  test('token adulterado, de tipo desconhecido, de cobrança ou de QR: 404 e nada muda', async () => {
    const t = links.tokenDescadastro(EMP, 'relatorio');
    const adulterado = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    const outroTipo = links.tokenDescadastro(EMP, 'marketing');
    const cobranca = links.tokenDescadastro(EMP, 'cobranca');
    const qr = links.linkQrDoPix('PIX').split('/').pop().replace('.png', '');
    for (const tk of [adulterado, outroTipo, cobranca, qr, 'lixo']) {
      expect((await request(app()).post('/emails/descadastro/' + tk).type('form').send('List-Unsubscribe=One-Click')).status).toBe(404);
      expect((await request(app()).get('/emails/descadastro/' + tk)).status).toBe(404);
    }
    expect(escritas).toHaveLength(0);
  });

  test('já desligado: não grava de novo', async () => {
    ligarBanco({ linhas: { [`${EMP}:relatorio`]: false } });
    const r = await desligarTipoDeEmail(db, EMP, 'relatorio');
    expect(r).toEqual({ ok: true, desligadas: [], jaEstava: true });
    expect(escritas.filter((e) => !e.s.startsWith('INSERT INTO company_email_prefs'))).toHaveLength(0);
  });

  test('consolidado (grupo): desliga todas as empresas do dono que recebiam', async () => {
    ligarBanco({ lista: [EMP, FILIAL] });
    const r = await desligarTipoDeEmail(db, EMP, 'relatorio', { grupo: true });
    expect(r.desligadas).toEqual([EMP, FILIAL]);
    expect(escritas.filter((e) => e.s.startsWith('INSERT INTO audit_log'))).toHaveLength(2);
  });
});

describe('confirmação de endereço extra', () => {
  const dados = { enderecoId: END, companyId: EMP, email: 'financeiro@loja.test' };

  test('link válido confirma e mostra a loja; abrir de novo continua ok', async () => {
    ligarBanco({ ends: [{ id: END, company_id: EMP, email: 'financeiro@loja.test', confirmado_em: null }] });
    const t = links.tokenConfirmacao(dados);
    const r = await request(app()).get('/emails/confirmar/' + t);
    expect(r.status).toBe(200);
    expect(r.text).toContain('E-mail confirmado');
    expect(r.text).toContain('da Finesse');
    expect(enderecos[0].confirmado_em).toBeInstanceOf(Date);
    const primeira = enderecos[0].confirmado_em;
    expect((await request(app()).get('/emails/confirmar/' + t)).status).toBe(200);
    expect(enderecos[0].confirmado_em).toBe(primeira);
  });

  test('vencido (7 dias): 410, nada muda', async () => {
    ligarBanco({ ends: [{ id: END, company_id: EMP, email: 'financeiro@loja.test', confirmado_em: null }] });
    const t = links.tokenConfirmacao(dados, process.env, Date.now() - 8 * 24 * 3600 * 1000);
    const r = await request(app()).get('/emails/confirmar/' + t);
    expect(r.status).toBe(410);
    expect(enderecos[0].confirmado_em).toBeNull();
  });

  test('endereço removido, token adulterado ou de descadastro: 404', async () => {
    ligarBanco({ ends: [] });
    const t = links.tokenConfirmacao(dados);
    expect((await request(app()).get('/emails/confirmar/' + t)).status).toBe(404);
    expect((await request(app()).get('/emails/confirmar/' + t.slice(0, -3) + 'xyz')).status).toBe(404);
    expect((await request(app()).get('/emails/confirmar/' + links.tokenDescadastro(EMP, 'relatorio'))).status).toBe(404);
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
