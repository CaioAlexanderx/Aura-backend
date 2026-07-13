// ============================================================
// AURA KARATÊ — Fase F4/PIX: header do e-mail (logo + nome da federação),
// QR do PIX embutido no e-mail (cid) e página pública de pagamento.
//
// Cobertura pedida no plano:
//   - e-mail renderiza SEM karate_logo_url (degrada pro nome, não quebra)
//     e COM karate_logo_url (mostra a imagem com alt = nome da federação).
//   - QR é gerado a partir do BR Code (getPixQrAttachment).
//   - a página pública (GET /public/karate/pix/:token) não vaza dado
//     pessoal — só valor, competência e o BR Code.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const mailer = require('../src/services/karateMailer');
const billingMailer = require('../src/services/karateBillingMailer');
const { signPixToken, verifyPixToken } = require('../src/services/karatePixPublicToken');

describe('karateMailer.layout — header logo + nome da federação', () => {
  it('COM karate_logo_url: mostra <img> com alt = nome da federação', () => {
    const html = mailer.layout('<p>corpo</p>', {
      federationName: 'FPKT',
      federationLogoUrl: 'https://cdn.example.com/fpkt-logo.png',
    });
    expect(html).toContain('https://cdn.example.com/fpkt-logo.png');
    expect(html).toContain('alt="FPKT"');
    expect(html).toContain('FPKT');
  });

  it('SEM karate_logo_url: degrada para só o nome, sem quebrar e sem <img> do header', () => {
    const html = mailer.layout('<p>corpo</p>', {
      federationName: 'Federação Sem Logo',
    });
    expect(html).toContain('Federação Sem Logo');
    // Não deve haver <img> de header (só o wordmark do rodapé, que usa ICON_URL fixo).
    const headerSection = html.split('<!-- Divisor sutil -->')[0];
    expect(headerSection).not.toContain('<img');
  });

  it('karate_logo_url ausente/null não lança exceção (nunca quebra o e-mail)', () => {
    expect(() => mailer.layout('<p>x</p>', { federationName: 'X', federationLogoUrl: null })).not.toThrow();
    expect(() => mailer.layout('<p>x</p>', {})).not.toThrow();
  });
});

describe('karateBillingMailer.getPixQrAttachment — QR gerado a partir do BR Code', () => {
  it('gera um anexo PNG válido com content_id (cid) a partir de um BR Code', async () => {
    const pixCode = '00020126360014BR.GOV.BCB.PIX0114+55119999999952040000530398654045.005802BR5913FPKT TESTE6008BRASILIA62070503***6304ABCD';
    const result = await billingMailer.getPixQrAttachment(pixCode);
    expect(result).not.toBeNull();
    expect(result.cid).toEqual(expect.stringMatching(/^pix-qr-/));
    expect(result.attachment.content_id).toBe(result.cid);
    expect(result.attachment.content_type).toBe('image/png');
    expect(result.attachment.filename).toBe('pix-qrcode.png');
    // content é base64 de um PNG (assinatura de arquivo PNG em base64 começa com iVBORw0KGgo)
    expect(result.attachment.content).toEqual(expect.stringMatching(/^iVBORw0KGgo/));
  });

  it('sem pixCode retorna null (nunca lança, e-mail segue sem QR)', async () => {
    await expect(billingMailer.getPixQrAttachment(null)).resolves.toBeNull();
    await expect(billingMailer.getPixQrAttachment('')).resolves.toBeNull();
  });
});

describe('karatePixPublicToken — token stateless do PIX de exibição', () => {
  const base = { amount: 500, referencePeriod: '2026', pixCode: '00020126PIXCODEDEEXEMPLO' };

  it('sign → verify roundtrip devolve exatamente amount/referencePeriod/pixCode', () => {
    const token = signPixToken(base);
    const decoded = verifyPixToken(token);
    expect(decoded).toEqual(base);
  });

  it('token adulterado (payload trocado) falha a verificação', () => {
    const token = signPixToken(base);
    const [payloadB64, sig] = token.split('.');
    const tampered = `${payloadB64}x.${sig}`;
    expect(verifyPixToken(tampered)).toBeNull();
  });

  it('token malformado/vazio/nulo não lança e retorna null', () => {
    expect(verifyPixToken('')).toBeNull();
    expect(verifyPixToken(null)).toBeNull();
    expect(verifyPixToken('lixo-sem-ponto')).toBeNull();
  });

  it('buildPublicPixUrl monta a URL com o token e aponta pra /karate/pix/', () => {
    const url = billingMailer.buildPublicPixUrl(base);
    expect(url).toMatch(/\/karate\/pix\/.+/);
    const token = url.split('/karate/pix/')[1];
    expect(verifyPixToken(token)).toEqual(base);
  });

  it('sem pixCode, buildPublicPixUrl retorna null (nada a assinar)', () => {
    expect(billingMailer.buildPublicPixUrl({ amount: 100, referencePeriod: '2026', pixCode: '' })).toBeNull();
  });
});

describe('GET /public/karate/pix/:token — página pública não vaza dado pessoal', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/public/karate', require('../src/routes/karatePixPublic'));
    return app;
  }

  it('token válido: resposta tem SÓ amount/reference_period/pix_code', async () => {
    const app = buildApp();
    const token = signPixToken({ amount: 320.5, referencePeriod: '2026', pixCode: '00020126PIXCODEDEEXEMPLO' });
    const res = await request(app).get(`/public/karate/pix/${token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['amount', 'pix_code', 'reference_period']);
    expect(res.body.amount).toBe(320.5);
    expect(res.body.reference_period).toBe('2026');
    expect(res.body.pix_code).toBe('00020126PIXCODEDEEXEMPLO');
    // Nunca nome/CPF/telefone/e-mail/ids de dojô ou praticante no payload.
    const bodyStr = JSON.stringify(res.body).toLowerCase();
    expect(bodyStr).not.toMatch(/name|nome|cpf|phone|telefone|email|dojo_id|practitioner_id/);
  });

  it('token inválido/adulterado → 404 genérico (nunca vaza o motivo)', async () => {
    const app = buildApp();
    const res = await request(app).get('/public/karate/pix/token-invalido');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
