// ============================================================
// AURA — AURINHA DE PLANTÃO: relógio (services/plantao.js)
//
// Regra (Brasília): 21:00→08:00 responde na hora; 08:00→21:00 espera 15
// min pelo humano e só então entra. Bordas testadas dos dois lados:
// 20:59 / 21:00 / 07:59 / 08:00 e 14:59 / 15:00 de espera.
//
// Brasília = UTC-3 (sem horário de verão desde 2019): 21:00 BRT = 00:00Z.
// ============================================================
'use strict';

const {
  deveResponderAgora, proximaAvaliacaoEm, emHorarioNoturno, resolverConfig, parseHHMM,
} = require('../src/services/plantao');

// Hora de parede de Brasília em 14/10/2026 → Date.
const brt = (hh, mm = 0, ss = 0, dia = 14) =>
  new Date(Date.UTC(2026, 9, dia, hh + 3, mm, ss));

describe('plantão — noite: responde na hora', () => {
  it('21:00 (início inclusivo): mensagem que acabou de chegar já é respondida', () => {
    expect(deveResponderAgora({ agora: brt(21, 0), ultimaMensagemClienteEm: brt(21, 0) })).toBe(true);
  });

  it('20:59 ainda é dia: mensagem que acabou de chegar espera', () => {
    expect(deveResponderAgora({ agora: brt(20, 59), ultimaMensagemClienteEm: brt(20, 59) })).toBe(false);
    expect(emHorarioNoturno(brt(20, 59))).toBe(false);
    expect(emHorarioNoturno(brt(21, 0))).toBe(true);
  });

  it('07:59 ainda é noite: responde na hora', () => {
    expect(deveResponderAgora({ agora: brt(7, 59), ultimaMensagemClienteEm: brt(7, 59) })).toBe(true);
    expect(emHorarioNoturno(brt(7, 59))).toBe(true);
  });

  it('08:00 já é dia (fim exclusivo): mensagem que acabou de chegar espera', () => {
    expect(emHorarioNoturno(brt(8, 0))).toBe(false);
    expect(deveResponderAgora({ agora: brt(8, 0), ultimaMensagemClienteEm: brt(8, 0) })).toBe(false);
  });

  it('meia-noite e madrugada fecham a conta da faixa que vira o dia', () => {
    expect(emHorarioNoturno(brt(0, 0))).toBe(true);
    expect(emHorarioNoturno(brt(3, 30))).toBe(true);
    expect(emHorarioNoturno(brt(12, 0))).toBe(false);
  });
});

describe('plantão — dia: espera 15 minutos pelo humano', () => {
  const cliente = brt(10, 0);

  it('14:59 de espera: ainda não', () => {
    expect(deveResponderAgora({ agora: brt(10, 14, 59), ultimaMensagemClienteEm: cliente })).toBe(false);
  });

  it('15:00 de espera: entra', () => {
    expect(deveResponderAgora({ agora: brt(10, 15, 0), ultimaMensagemClienteEm: cliente })).toBe(true);
  });

  it('mensagem do cliente 20:50 vira noite 21:00 e é respondida (10 min < 15, mas é noite)', () => {
    const c = brt(20, 50);
    expect(deveResponderAgora({ agora: brt(20, 59), ultimaMensagemClienteEm: c })).toBe(false);
    expect(deveResponderAgora({ agora: brt(21, 0), ultimaMensagemClienteEm: c })).toBe(true);
  });

  it('sem fala do cliente, a espera conta a partir da fala do humano', () => {
    const humano = brt(10, 0);
    expect(deveResponderAgora({ agora: brt(10, 14), ultimaMensagemHumanaEm: humano })).toBe(false);
    expect(deveResponderAgora({ agora: brt(10, 15), ultimaMensagemHumanaEm: humano })).toBe(true);
  });

  it('sem nenhuma âncora, de dia o humano tem a vez', () => {
    expect(deveResponderAgora({ agora: brt(10, 0) })).toBe(false);
    // …e de noite não precisa de âncora
    expect(deveResponderAgora({ agora: brt(23, 0) })).toBe(true);
  });
});

describe('plantão — humano já respondeu', () => {
  it('humano depois do cliente: não entra, nem de noite nem de dia', () => {
    const cliente = brt(22, 0);
    const humano = brt(22, 3);
    expect(deveResponderAgora({ agora: brt(22, 5), ultimaMensagemClienteEm: cliente, ultimaMensagemHumanaEm: humano })).toBe(false);
    const c2 = brt(10, 0); const h2 = brt(10, 1);
    expect(deveResponderAgora({ agora: brt(11, 0), ultimaMensagemClienteEm: c2, ultimaMensagemHumanaEm: h2 })).toBe(false);
  });

  it('humano ANTES do cliente não segura a Aurinha de noite', () => {
    expect(deveResponderAgora({
      agora: brt(23, 0), ultimaMensagemClienteEm: brt(23, 0), ultimaMensagemHumanaEm: brt(22, 58),
    })).toBe(true);
  });
});

describe('plantão — configuração (hub_agent_settings.plantao)', () => {
  it('ativo=false: nunca responde sozinha', () => {
    expect(deveResponderAgora({ agora: brt(23, 0), ultimaMensagemClienteEm: brt(23, 0), config: { ativo: false } })).toBe(false);
  });

  it('janela e espera configuráveis', () => {
    const config = { noite_inicio: '22:30', noite_fim: '06:00', espera_minutos: 5 };
    const c = brt(22, 0);
    // 22:00 não é mais noite; 5 min de espera
    expect(deveResponderAgora({ agora: brt(22, 4), ultimaMensagemClienteEm: c, config })).toBe(false);
    expect(deveResponderAgora({ agora: brt(22, 5), ultimaMensagemClienteEm: c, config })).toBe(true);
    // 22:30 entra a noite
    expect(deveResponderAgora({ agora: brt(22, 30), ultimaMensagemClienteEm: brt(22, 30), config })).toBe(true);
    // 06:00 acabou a noite
    expect(deveResponderAgora({ agora: brt(6, 0), ultimaMensagemClienteEm: brt(6, 0), config })).toBe(false);
  });

  it('config quebrada cai nos defaults (21h–8h, 15 min), nunca no extremo', () => {
    const lixo = { noite_inicio: '25:99', noite_fim: 'abc', espera_minutos: -3, ativo: 'talvez' };
    const cfg = resolverConfig(lixo);
    expect(cfg.noiteInicioMin).toBe(21 * 60);
    expect(cfg.noiteFimMin).toBe(8 * 60);
    expect(cfg.esperaMinutos).toBe(15);
    expect(cfg.ativo).toBe(true);
    expect(deveResponderAgora({ agora: brt(21, 0), ultimaMensagemClienteEm: brt(21, 0), config: lixo })).toBe(true);
    expect(deveResponderAgora({ agora: brt(20, 59), ultimaMensagemClienteEm: brt(20, 59), config: lixo })).toBe(false);
    expect(resolverConfig(null).esperaMinutos).toBe(15);
  });

  it('data inválida não responde', () => {
    expect(deveResponderAgora({ agora: 'não-é-data', ultimaMensagemClienteEm: brt(10, 0) })).toBe(false);
  });

  it('parseHHMM', () => {
    expect(parseHHMM('21:00')).toBe(1260);
    expect(parseHHMM('8')).toBe(480);
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });

  it('aceita ISO string e epoch além de Date', () => {
    const cliente = brt(10, 0).toISOString();
    expect(deveResponderAgora({ agora: brt(10, 15).getTime(), ultimaMensagemClienteEm: cliente })).toBe(true);
  });
});

describe('plantão — proximaAvaliacaoEm', () => {
  it('de dia: âncora + espera; de noite: agora; humano já respondeu: null', () => {
    const c = brt(10, 0);
    expect(proximaAvaliacaoEm({ agora: brt(10, 3), ultimaMensagemClienteEm: c }).toISOString())
      .toBe(brt(10, 15).toISOString());
    const noite = brt(23, 0);
    expect(proximaAvaliacaoEm({ agora: noite, ultimaMensagemClienteEm: noite }).toISOString())
      .toBe(noite.toISOString());
    expect(proximaAvaliacaoEm({
      agora: brt(10, 3), ultimaMensagemClienteEm: c, ultimaMensagemHumanaEm: brt(10, 2),
    })).toBeNull();
    expect(proximaAvaliacaoEm({ agora: brt(10, 3), ultimaMensagemClienteEm: c, config: { ativo: false } })).toBeNull();
  });
});
