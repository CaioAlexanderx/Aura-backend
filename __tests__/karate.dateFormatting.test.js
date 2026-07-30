// ============================================================
// AURA KARATÊ — QA de produção 30/07/2026
//
// Regressão do bug que CHEGAVA AO ALUNO: a mensagem de uma cobrança com
// vencimento 10/07/2026 dizia "venceu em 09/07/2026".
//
// Causa: `new Date('2026-07-10')` é meia-noite UTC; formatada em
// America/Sao_Paulo (UTC−3) volta para 09/07. Como a régua do dojô entrega
// a data como STRING data-only (`to_char(c.due_date,'YYYY-MM-DD')`) e o pg
// entrega colunas `date` como Date à meia-noite UTC, TODA cobrança saía com
// o dia anterior.
//
// Testes PUROS (sem DB, sem rede): karateMailer.fmtDateBR /
// karateMailer.fmtCompetenceBR e os dois textos da régua do dojô
// (whatsappMessage e bodyFor).
// ============================================================
'use strict';

const mailer = require('../src/services/karateMailer');
const dojoReminder = require('../src/services/karateDojoReminderEngine');

const DAY_MS = 24 * 60 * 60 * 1000;
const SP_OFFSET_MS = 3 * 60 * 60 * 1000;

describe('fmtDateBR — DATA PURA nunca passa por fuso', () => {
  it('o caso reproduzido em produção: 2026-07-10 → 10/07/2026 (não 09/07)', () => {
    expect(mailer.fmtDateBR('2026-07-10')).toBe('10/07/2026');
  });

  it('prova do mecanismo do bug: interpretar a mesma string como instante e ler em São Paulo volta um dia', () => {
    // Sem ICU/locale (o Railway roda sem full-icu): só aritmética.
    // new Date('2026-07-10') = 2026-07-10T00:00:00Z → −3h = 09/07 21:00.
    const naive = new Date(new Date('2026-07-10').getTime() - SP_OFFSET_MS);
    expect(naive.getUTCDate()).toBe(9);
    // ...e é exatamente isso que fmtDateBR não faz mais.
    expect(mailer.fmtDateBR('2026-07-10')).toBe('10/07/2026');
  });

  it('servidor em UTC (Railway/CI): coluna `date` do pg chega como Date à meia-noite UTC e continua sendo o mesmo dia', () => {
    // É o formato exato que node-postgres entrega para uma coluna `date`
    // e o que karateReminderRunner passa para o e-mail de anuidade.
    expect(mailer.fmtDateBR(new Date('2026-07-10T00:00:00.000Z'))).toBe('10/07/2026');
    expect(mailer.fmtDateBR(new Date(Date.UTC(2026, 0, 1)))).toBe('01/01/2026');
  });

  it('é estável a qualquer TZ do processo (UTC, São Paulo, Tóquio)', () => {
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        expect(mailer.fmtDateBR('2026-07-10')).toBe('10/07/2026');
        expect(mailer.fmtDateBR('2026-01-01')).toBe('01/01/2026');
        expect(mailer.fmtDateBR('2026-12-31')).toBe('31/12/2026');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('vira/fim de ano e mês de 1 dígito continuam com zero à esquerda', () => {
    expect(mailer.fmtDateBR('2025-12-31')).toBe('31/12/2025');
    expect(mailer.fmtDateBR('2026-01-05')).toBe('05/01/2026');
  });

  it('TIMESTAMP REAL continua sendo lido em São Paulo (aí o fuso importa)', () => {
    // 23h UTC de 10/07 = 20h de 10/07 em Brasília → mesmo dia.
    expect(mailer.fmtDateBR('2026-07-10T23:00:00.000Z')).toBe('10/07/2026');
    // 01h UTC de 11/07 = 22h de 10/07 em Brasília → dia ANTERIOR, correto.
    expect(mailer.fmtDateBR('2026-07-11T01:00:00.000Z')).toBe('10/07/2026');
    // 05h UTC de 11/07 = 02h de 11/07 em Brasília.
    expect(mailer.fmtDateBR('2026-07-11T05:00:00.000Z')).toBe('11/07/2026');
  });

  it('ausente/vazio → string vazia (nunca "31/12/1969"); lixo volta como veio', () => {
    expect(mailer.fmtDateBR(null)).toBe('');
    expect(mailer.fmtDateBR(undefined)).toBe('');
    expect(mailer.fmtDateBR('')).toBe('');
    expect(mailer.fmtDateBR('nao-e-data')).toBe('nao-e-data');
  });
});

describe('fmtCompetenceBR — competência legível para a família', () => {
  it("'2026-07' → 'julho/2026'", () => {
    expect(mailer.fmtCompetenceBR('2026-07')).toBe('julho/2026');
  });

  it('cobre os 12 meses em pt-BR', () => {
    const esperado = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    ];
    esperado.forEach((nome, i) => {
      const mm = String(i + 1).padStart(2, '0');
      expect(mailer.fmtCompetenceBR(`2026-${mm}`)).toBe(`${nome}/2026`);
    });
  });

  it('aceita AAAA-MM-DD (usa mês/ano) e ignora o dia', () => {
    expect(mailer.fmtCompetenceBR('2026-07-05')).toBe('julho/2026');
  });

  it('valor fora do formato volta inalterado — nunca inventa mês', () => {
    expect(mailer.fmtCompetenceBR('julho/2026')).toBe('julho/2026');
    expect(mailer.fmtCompetenceBR('2026-13')).toBe('2026-13');
    expect(mailer.fmtCompetenceBR('')).toBe('');
    expect(mailer.fmtCompetenceBR(null)).toBe('');
  });
});

describe('régua do dojô — texto que chega ao aluno', () => {
  const charge = {
    id: 'c1',
    amount: '140.00',
    competence: '2026-07',
    due_date: '2026-07-10', // to_char(due_date,'YYYY-MM-DD')
    student_name: 'Aluno Teste',
  };
  const meta = { name: 'Dojô QA' };

  it('WhatsApp em atraso: "venceu em 10/07/2026" (era 09/07) e "referente a julho/2026" (era 2026-07)', () => {
    const msg = dojoReminder.whatsappMessage(3, charge, meta, null);
    expect(msg).toContain('venceu em 10/07/2026');
    expect(msg).toContain('referente a julho/2026');
    expect(msg).not.toContain('09/07/2026');
    expect(msg).not.toContain('2026-07,');
  });

  it('WhatsApp a vencer e no dia usam a mesma data corrigida', () => {
    expect(dojoReminder.whatsappMessage(-3, charge, meta, null)).toContain('vence em 10/07/2026');
    expect(dojoReminder.whatsappMessage(0, charge, meta, null)).toContain('vence hoje (10/07/2026)');
  });

  it('e-mail da régua (bodyFor) carrega a mesma data e a mesma competência', () => {
    const { bodyHtml, heading } = dojoReminder.bodyFor(0, charge, meta);
    expect(heading).toBe('Mensalidade vence hoje');
    expect(bodyHtml).toContain('julho/2026');
    expect(bodyHtml).toContain('10/07/2026');
    expect(bodyHtml).not.toContain('2026-07<');
    expect(bodyHtml).not.toContain('09/07/2026');
  });
});

describe('sanidade da aritmética usada nos helpers', () => {
  it('um dia tem 86.400.000 ms e São Paulo é UTC−3 o ano todo (DST abolido em 2019)', () => {
    expect(DAY_MS).toBe(86400000);
    expect(SP_OFFSET_MS).toBe(10800000);
  });
});
