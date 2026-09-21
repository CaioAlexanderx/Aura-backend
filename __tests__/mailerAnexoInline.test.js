// ============================================================
// Anexo inline (cid) no Resend — 18/09/2026
// O QR do PIX do e-mail de notificação chegou como imagem quebrada: o
// anexo ia sem content_type. O corpo enviado ao Resend precisa levar
// content_id E content_type (mesmo formato do karateBillingMailer).
// ============================================================
'use strict';

describe('sendMail pelo Resend com imagem inline', () => {
  const OLD = process.env.RESEND_API_KEY;
  beforeAll(() => { process.env.RESEND_API_KEY = 'test-key'; });
  afterAll(() => { process.env.RESEND_API_KEY = OLD; });

  test('anexo vai em base64 com content_id e content_type', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: 're_1' }) };
    });
    const { sendMail } = require('../src/services/mailer');
    await sendMail({
      to: 'a@b.com', subject: 's', html: '<img src="cid:pix-qrcode">', text: 't',
      attachments: [{ filename: 'pix-qrcode.png', content: Buffer.from([0x89, 0x50]), cid: 'pix-qrcode', contentType: 'image/png' }],
    });
    expect(calls[0].attachments).toEqual([
      { filename: 'pix-qrcode.png', content: Buffer.from([0x89, 0x50]).toString('base64'), content_id: 'pix-qrcode', content_type: 'image/png' },
    ]);
  });

  test('e-mail sem anexo não manda o campo', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: 're_2' }) };
    });
    const { sendMail } = require('../src/services/mailer');
    await sendMail({ to: 'a@b.com', subject: 's', html: '<p>x</p>', text: 't' });
    expect(calls[0]).not.toHaveProperty('attachments');
  });
});
