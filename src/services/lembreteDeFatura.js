// ============================================================
// AURA. — Lembrete de fatura agendado (07/10/2026, migration 367)
//
// Pedido do Caio: o lembrete de pagamento da assinatura aparece no sininho
// do cliente numa data marcada (2 dias antes do vencimento), com o QR Code
// e o Pix copia e cola da fatura; no dia do vencimento, se o pagamento não
// entrou, a Aura recebe um aviso no próprio sininho.
//
// A agenda é a tabela invoice_reminders. Cada volta do job passa pelas
// linhas em andamento cujo dia de aviso já chegou e, para cada uma:
//
//   1. consulta a cobrança no Asaas (valor, vencimento, situação);
//   2. já paga → tira o banner do ar (se houver) e encerra;
//   3. ainda sem banner → busca o Pix da cobrança e publica o banner; com
//      send_email, manda o mesmo lembrete por e-mail (dono + empresa);
//   4. dia do vencimento, a partir das 18h de Brasília, ainda em aberto →
//      avisa a empresa de alert_company_id e encerra.
//
// Valor, vencimento e Pix vêm do Asaas na hora de publicar, nunca da
// tabela: o Pix de uma cobrança pode ser regerado e o valor pode mudar
// (cupom) entre o agendamento e o aviso.
//
// Nada aqui lança por causa de uma linha: a falha é logada e a linha fica
// para a próxima volta (o Asaas fora do ar às 8h não perde o lembrete).
// ============================================================
'use strict';

const QRCode = require('qrcode');
const { escapeHtml } = require('./mailer');

const HORA_DO_ALERTA_BRT = 18;
// O banner fica até 2 dias depois do vencimento: quem atrasou ainda acha o
// Pix no sininho.
const DIAS_NO_AR_APOS_VENCER = 2;

const PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const DESFEITO = new Set(['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS']);

const DIAS_DA_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function brl(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** AAAA-MM-DD → DD/MM/AAAA (sem new Date: data pura viraria UTC). */
function dataBr(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function diaDaSemana(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return DIAS_DA_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function somarDias(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Dia civil e hora de São Paulo (UTC-3, sem horário de verão). */
function agoraBrt(now) {
  const brt = new Date(now - 3 * 3600000);
  return { hoje: brt.toISOString().slice(0, 10), hora: brt.getUTCHours() };
}

// A descrição da cobrança carrega o cupom ("Aura Negocio — cupom X: ...");
// no lembrete entra só o nome do plano.
function nomeDoPlano(description) {
  const s = String(description || '').split(' — cupom ')[0].trim();
  return s || 'Assinatura Aura';
}

function linkDaFatura(payment) {
  return payment.invoiceUrl || 'https://www.asaas.com/i/' + String(payment.id).replace(/^pay_/, '');
}

/**
 * Peça HTML do sininho (3:2, 1080×720 — o app escala no BannerFrame).
 * Mesmo desenho dos lembretes publicados à mão em ago–set/2026.
 */
function montarHtml({ plano, numero, valor, vencimento, pixCode, qrBase64 }) {
  const sub = escapeHtml(plano) + (numero ? ' · fatura nº ' + escapeHtml(numero) : '');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Lembrete de pagamento</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 720px; overflow: hidden; }
  body {
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
    background: radial-gradient(120% 90% at 0% 0%, #2a1260 0%, #150a33 55%, #0d0724 100%);
    color: #fff;
    display: flex;
    padding: 56px 56px 52px 64px;
    gap: 48px;
  }
  .left { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .kicker {
    display: inline-flex; align-items: center; gap: 10px; align-self: flex-start;
    background: rgba(245, 158, 11, 0.16); border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fbbf24; font-size: 20px; font-weight: 700; letter-spacing: 0.3px;
    padding: 8px 18px; border-radius: 999px;
  }
  .kicker .dot { width: 10px; height: 10px; border-radius: 50%; background: #f59e0b; }
  h1 { font-size: 52px; line-height: 1.08; font-weight: 800; margin-top: 26px; letter-spacing: -0.8px; }
  .sub { font-size: 23px; color: #c4b5fd; margin-top: 12px; }
  .facts { display: flex; gap: 18px; margin-top: 34px; }
  .fact {
    flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 18px; padding: 18px 22px;
  }
  .fact .lbl { font-size: 17px; color: #a5a1c4; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  .fact .val { font-size: 40px; font-weight: 800; margin-top: 6px; letter-spacing: -0.5px; }
  .fact .val small { display: block; font-size: 18px; font-weight: 600; color: #fbbf24; margin-top: 2px; letter-spacing: 0; }
  .code-lbl { font-size: 17px; color: #a5a1c4; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-top: auto; }
  .code-row { display: flex; gap: 12px; margin-top: 10px; align-items: stretch; }
  .code {
    flex: 1; min-width: 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 15px; line-height: 1.45; color: #e9e5ff;
    background: rgba(0,0,0,0.35); border: 1px dashed rgba(196,181,253,0.45);
    border-radius: 14px; padding: 12px 16px;
    word-break: break-all; user-select: all; -webkit-user-select: all;
  }
  button.copy {
    flex: 0 0 auto; width: 150px; border: none; border-radius: 14px; cursor: pointer;
    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #fff;
    font: inherit; font-size: 21px; font-weight: 800;
  }
  button.copy.ok { background: #10b981; }

  .right { width: 400px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .qr-card {
    background: #fff; border-radius: 28px; padding: 22px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }
  .qr-card img { display: block; width: 356px; height: 356px; image-rendering: pixelated; }
  .qr-cap { margin-top: 20px; text-align: center; font-size: 21px; color: #c4b5fd; line-height: 1.35; }
  .qr-cap b { color: #fff; }
  .brand { margin-top: 18px; font-size: 17px; color: #7d77a3; letter-spacing: 0.4px; }
</style>
</head>
<body>
  <div class="left">
    <span class="kicker"><span class="dot"></span>Vence em ${escapeHtml(dataBr(vencimento).slice(0, 5))}</span>
    <h1>Lembrete de pagamento da sua assinatura Aura</h1>
    <p class="sub">${sub}</p>

    <div class="facts">
      <div class="fact"><div class="lbl">Valor</div><div class="val">${escapeHtml(brl(valor)).replace(' ', '&nbsp;')}</div></div>
      <div class="fact"><div class="lbl">Vencimento</div><div class="val">${escapeHtml(dataBr(vencimento))}<small>${escapeHtml(diaDaSemana(vencimento))}</small></div></div>
    </div>

    <div class="code-lbl">PIX copia e cola</div>
    <div class="code-row">
      <div class="code" id="pix">${escapeHtml(pixCode)}</div>
      <button class="copy" id="copy" type="button">Copiar</button>
    </div>
  </div>

  <div class="right">
    <div class="qr-card">
      <img alt="QR Code PIX da fatura" src="data:image/png;base64,${qrBase64}">
    </div>
    <p class="qr-cap">Abra o app do seu banco,<br>escolha <b>Pagar com PIX</b> e escaneie</p>
    <p class="brand">Cobrança emitida por AURA LTDA via Asaas</p>
  </div>

<script>
  (function () {
    var btn = document.getElementById('copy');
    var code = document.getElementById('pix').textContent.trim();
    function done(ok) {
      btn.textContent = ok ? 'Copiado!' : 'Selecione';
      btn.classList.toggle('ok', ok);
      if (!ok) {
        var r = document.createRange();
        r.selectNodeContents(document.getElementById('pix'));
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      setTimeout(function () { btn.textContent = 'Copiar'; btn.classList.remove('ok'); }, 2500);
    }
    function legacy() {
      try {
        var t = document.createElement('textarea');
        t.value = code; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(t);
        done(ok);
      } catch (e) { done(false); }
    }
    btn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { done(true); }, legacy);
      } else { legacy(); }
    });
  })();
</script>
</body>
</html>
`;
}

/**
 * Tudo o que o banner e o e-mail precisam, a partir da cobrança e do Pix.
 * Pura (sem banco, sem rede): testável.
 */
function montarLembrete({ payment, pixCode, qrBase64, extraNote }) {
  const plano = nomeDoPlano(payment.description);
  const vencimento = payment.dueDate;
  const resumo = `${plano} — ${brl(payment.value)}, vencimento ${dataBr(vencimento)}. ` +
    'Pague via Pix pelo QR Code ou pelo código copia e cola.' +
    (extraNote ? ' ' + String(extraNote).trim() : '');
  return {
    title: `Sua fatura Aura vence em ${dataBr(vencimento).slice(0, 5)}`,
    // O código vai também no texto: é o que sobra onde a peça HTML não
    // é desenhada. O e-mail usa `resumo` — lá o código tem bloco próprio.
    body: `${resumo}\n\nPIX copia e cola: ${pixCode}`,
    resumo,
    htmlContent: montarHtml({
      plano, numero: payment.invoiceNumber, valor: payment.value, vencimento, pixCode, qrBase64,
    }),
    ctaLabel: 'Abrir fatura no Asaas',
    ctaUrl: linkDaFatura(payment),
    expiresAt: `${somarDias(vencimento, DIAS_NO_AR_APOS_VENCER)}T23:59:59-03:00`,
  };
}

// QR Code e copia e cola da cobrança. A imagem é a do Asaas; se ela não
// vier, é gerada do próprio código — o mesmo QR.
async function buscarPix(asaas, paymentId) {
  const pix = await asaas('GET', '/payments/' + encodeURIComponent(paymentId) + '/pixQrCode');
  const pixCode = pix && pix.payload ? String(pix.payload).trim() : '';
  if (!pixCode) throw new Error('Asaas não devolveu o Pix da cobrança');
  let qrBase64 = pix.encodedImage ? String(pix.encodedImage).replace(/\s+/g, '') : '';
  if (!/^[A-Za-z0-9+/=]+$/.test(qrBase64)) {
    const png = await QRCode.toBuffer(pixCode, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 400 });
    qrBase64 = png.toString('base64');
  }
  return { pixCode, qrBase64 };
}

async function encerrar(db, row, outcome) {
  await db.query(
    `UPDATE invoice_reminders SET outcome = $2, resolved_at = NOW() WHERE id = $1 AND outcome IS NULL`,
    [row.id, outcome]
  );
}

async function tirarBannerDoAr(db, row) {
  if (!row.notification_id) return;
  await db.query(
    `UPDATE app_notifications SET is_active = false, updated_at = NOW() WHERE id = $1`,
    [row.notification_id]
  );
}

async function publicar({ db, asaas, notifications, row, payment, summary }) {
  const { pixCode, qrBase64 } = await buscarPix(asaas, row.asaas_payment_id);
  const l = montarLembrete({ payment, pixCode, qrBase64, extraNote: row.extra_note });

  // Reserva antes de publicar: duas voltas (ou duas instâncias) não
  // publicam o mesmo lembrete.
  const { rows: claimed } = await db.query(
    `UPDATE invoice_reminders SET notified_at = NOW()
      WHERE id = $1 AND notified_at IS NULL
    RETURNING id`,
    [row.id]
  );
  if (!claimed.length) return null;

  const dedupeKey = `fatura-aura:${row.asaas_payment_id}:${row.company_id}`;
  let banner = await notifications.notifyCompany(row.company_id, {
    title: l.title, body: l.body, htmlContent: l.htmlContent,
    ctaLabel: l.ctaLabel, ctaUrl: l.ctaUrl, expiresAt: l.expiresAt, dedupeKey,
  });
  // null = falha de escrita OU a chave já existe (uma volta anterior
  // publicou e caiu antes de gravar o id).
  if (!banner) {
    const { rows } = await db.query(
      `SELECT id, title, target_company_id FROM app_notifications WHERE dedupe_key = $1`,
      [dedupeKey]
    );
    banner = rows[0] || null;
  }
  if (!banner) {
    await db.query(`UPDATE invoice_reminders SET notified_at = NULL WHERE id = $1`, [row.id]);
    throw new Error('banner não foi criado');
  }

  await db.query(`UPDATE invoice_reminders SET notification_id = $2 WHERE id = $1`, [row.id, banner.id]);
  row.notification_id = banner.id;
  summary.publicados++;
  console.log(`[lembreteFatura] banner publicado: company=${row.company_id} cobranca=${row.asaas_payment_id}`);
  return { banner, lembrete: l, pixCode };
}

async function enviarEmail({ db, emailer, row, payment, banner, lembrete, pixCode, summary }) {
  const data = await emailer.listRecipients(row.company_id);
  const recipients = data ? data.recipients.filter((r) => r.selected).map((r) => r.email) : [];
  if (!recipients.length) {
    console.warn(`[lembreteFatura] sem e-mail no cadastro: company=${row.company_id}`);
    return;
  }
  const r = await emailer.sendNotificationEmails({
    notification: {
      id: banner.id, title: lembrete.title, body: lembrete.resumo,
      cta_label: lembrete.ctaLabel, cta_url: lembrete.ctaUrl, target_company_id: row.company_id,
    },
    recipients,
    subject: lembrete.title,
    pix: { code: pixCode, amount: Number(payment.value), dueDate: payment.dueDate },
    sentBy: null,
  });
  if (!r.sent.length) throw new Error('e-mail não saiu para nenhum destinatário');
  await db.query(`UPDATE invoice_reminders SET email_sent_at = NOW() WHERE id = $1`, [row.id]);
  summary.emails += r.sent.length;
}

async function alertar({ db, notifications, row, payment, hoje, summary }) {
  if (!row.alert_company_id) return encerrar(db, row, 'unpaid');
  const alerta = await notifications.notifyCompany(row.alert_company_id, {
    title: `Pagamento não recebido: ${row.company_name}`,
    body: `A fatura de ${brl(payment.value)} (${nomeDoPlano(payment.description)}) ` +
      `${hoje > row.due_date ? 'venceu em' : 'vence hoje,'} ${dataBr(row.due_date)}` +
      `${hoje > row.due_date ? '' : ','} e o pagamento ainda não entrou no Asaas.`,
    ctaLabel: 'Abrir fatura no Asaas',
    ctaUrl: linkDaFatura(payment),
    // Uma cobrança pode ter mais de uma linha (grupo com duas empresas):
    // a chave é da cobrança, o aviso sai uma vez só.
    dedupeKey: `fatura-aura-nao-paga:${row.asaas_payment_id}`,
  });
  if (alerta) summary.alertas++;
  await encerrar(db, row, 'unpaid_alerted');
}

async function processar({ db, asaas, notifications, emailer, row, hoje, hora, summary }) {
  const payment = await asaas('GET', '/payments/' + encodeURIComponent(row.asaas_payment_id));

  if (PAGO.has(payment.status)) {
    await tirarBannerDoAr(db, row);
    await encerrar(db, row, 'paid');
    summary.pagos++;
    return;
  }
  if (payment.deleted || DESFEITO.has(payment.status)) {
    await tirarBannerDoAr(db, row);
    await encerrar(db, row, 'gone');
    console.warn(`[lembreteFatura] cobrança removida ou estornada no Asaas: ${row.asaas_payment_id}`);
    return;
  }

  // O vencimento que vale é o do Asaas (pode ter sido prorrogado).
  if (payment.dueDate && payment.dueDate !== row.due_date) {
    await db.query(`UPDATE invoice_reminders SET due_date = $2 WHERE id = $1`, [row.id, payment.dueDate]);
    row.due_date = payment.dueDate;
  }

  if (!row.notified_at) {
    const pub = await publicar({ db, asaas, notifications, row, payment, summary });
    if (pub && row.send_email) {
      // Falha de e-mail não desfaz o banner; a próxima volta tenta de novo.
      try { await enviarEmail({ db, emailer, row, payment, ...pub, summary }); }
      catch (err) { console.error(`[lembreteFatura] e-mail falhou: company=${row.company_id}: ${err.message}`); }
    }
  } else if (row.send_email && !row.email_sent_at && row.notification_id && hoje <= row.due_date) {
    const { pixCode, qrBase64 } = await buscarPix(asaas, row.asaas_payment_id);
    const lembrete = montarLembrete({ payment, pixCode, qrBase64, extraNote: row.extra_note });
    await enviarEmail({ db, emailer, row, payment, banner: { id: row.notification_id }, lembrete, pixCode, summary });
  }

  if (hoje > row.due_date || (hoje === row.due_date && hora >= HORA_DO_ALERTA_BRT)) {
    await alertar({ db, notifications, row, payment, hoje, summary });
  }
}

/**
 * Uma volta. @param deps {{ db, asaas, notifications, emailer, now? }} —
 * injetável para teste.
 */
async function tickLembretesDeFatura({ db, asaas, notifications, emailer, now = Date.now() }) {
  const { hoje, hora } = agoraBrt(now);
  const summary = { vistos: 0, publicados: 0, emails: 0, pagos: 0, alertas: 0, falhas: 0 };

  const { rows } = await db.query(
    `SELECT r.id, r.company_id, r.asaas_payment_id,
            to_char(r.notify_on, 'YYYY-MM-DD') AS notify_on,
            to_char(r.due_date, 'YYYY-MM-DD')  AS due_date,
            r.send_email, r.alert_company_id, r.extra_note,
            r.notified_at, r.notification_id, r.email_sent_at,
            COALESCE(c.trade_name, c.legal_name) AS company_name
       FROM invoice_reminders r
       JOIN companies c ON c.id = r.company_id
      WHERE r.outcome IS NULL
        AND r.notify_on <= $1::date
      ORDER BY r.notify_on, r.id`,
    [hoje]
  );

  for (const row of rows) {
    summary.vistos++;
    try {
      await processar({ db, asaas, notifications, emailer, row, hoje, hora, summary });
    } catch (err) {
      summary.falhas++;
      console.error(`[lembreteFatura] company=${row.company_id} cobranca=${row.asaas_payment_id}: ${err.message}`);
    }
  }
  return summary;
}

module.exports = {
  tickLembretesDeFatura,
  montarLembrete,
  montarHtml,
  nomeDoPlano,
  agoraBrt,
  HORA_DO_ALERTA_BRT,
  DIAS_NO_AR_APOS_VENCER,
};
