// ============================================================
// AURA. — plantao.js
// Relógio da Aurinha de plantão: QUANDO ela pode falar sozinha.
//
// Regra (decisão de 13/10/2026), no horário de Brasília:
//   21:00 → 08:00  noite: responde na hora.
//   08:00 → 21:00  dia: dá 15 minutos para o humano; só entra se a
//                  mensagem do cliente continua sem resposta depois disso.
// 21:00 é noite (início inclusivo); 08:00 já é dia (fim exclusivo).
//
// Em qualquer horário, se o humano já falou DEPOIS da última mensagem do
// cliente, não há nada a responder — a Aurinha não entra.
//
// Função pura: não toca em banco, nem em relógio. Quem chama passa
// `agora`. A config vem de hub_agent_settings.plantao (jsonb) e qualquer
// campo ausente ou inválido cai no default — config quebrada nunca pode
// calar nem soltar a Aurinha por acidente.
//
//   {
//     "ativo": true,                 // false = nunca responde sozinha
//     "noite_inicio": "21:00",
//     "noite_fim": "08:00",
//     "espera_minutos": 15,          // espera de dia pelo humano
//     "template": { "nome": "...", "idioma": "pt_BR" }  // fora das 24h
//   }
// ============================================================
'use strict';

const TIMEZONE = 'America/Sao_Paulo';

const DEFAULTS = Object.freeze({
  ativo: true,
  noiteInicioMin: 21 * 60,
  noiteFimMin: 8 * 60,
  esperaMinutos: 15,
  template: null,
});

const ESPERA_MAX_MINUTOS = 24 * 60;

// "21:00" | "21" | "21:30" → minutos desde 00:00; inválido → null.
function parseHHMM(v) {
  if (v == null) return null;
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(v));
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] != null ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function resolverConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const inicio = parseHHMM(c.noite_inicio);
  const fim = parseHHMM(c.noite_fim);
  let espera = Number(c.espera_minutos);
  if (!Number.isFinite(espera) || espera < 0) espera = DEFAULTS.esperaMinutos;
  espera = Math.min(Math.floor(espera), ESPERA_MAX_MINUTOS);
  const tpl = c.template && typeof c.template === 'object' && c.template.nome
    ? { nome: String(c.template.nome), idioma: String(c.template.idioma || 'pt_BR') }
    : null;
  return {
    ativo: c.ativo === false ? false : true,
    noiteInicioMin: inicio != null ? inicio : DEFAULTS.noiteInicioMin,
    noiteFimMin: fim != null ? fim : DEFAULTS.noiteFimMin,
    esperaMinutos: espera,
    template: tpl,
  };
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const _fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Minutos desde 00:00 no relógio de Brasília.
function minutosDoDiaBRT(date) {
  const parts = _fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function emHorarioNoturno(agora, config) {
  const cfg = resolverConfig(config);
  const d = toDate(agora);
  if (!d) return false;
  const m = minutosDoDiaBRT(d);
  const { noiteInicioMin: ini, noiteFimMin: fim } = cfg;
  if (ini === fim) return false;               // sem faixa de noite configurada
  return ini > fim ? (m >= ini || m < fim) : (m >= ini && m < fim);
}

// A Aurinha pode falar AGORA nesta conversa?
//   agora                    Date | ISO | epoch
//   ultimaMensagemHumanaEm   última fala de um humano (ou null)
//   ultimaMensagemClienteEm  última fala do cliente — âncora da espera de
//                            dia. Sem ela, de dia a espera conta a partir
//                            da fala do humano; sem nenhuma das duas, de
//                            dia o humano tem a vez (false).
//   config                   hub_agent_settings.plantao
function deveResponderAgora({ agora, ultimaMensagemHumanaEm = null, ultimaMensagemClienteEm = null, config = null } = {}) {
  const cfg = resolverConfig(config);
  if (!cfg.ativo) return false;
  const now = toDate(agora);
  if (!now) return false;

  const humano = toDate(ultimaMensagemHumanaEm);
  const cliente = toDate(ultimaMensagemClienteEm);

  // Humano já respondeu depois do cliente: nada pendente.
  if (humano && cliente && humano.getTime() >= cliente.getTime()) return false;

  if (emHorarioNoturno(now, config)) return true;

  const ancora = cliente || humano;
  if (!ancora) return false;
  return now.getTime() - ancora.getTime() >= cfg.esperaMinutos * 60000;
}

// Quando a Aurinha passa a poder responder, se ainda não pode — para o
// evento "resposta_agendada" e para a tela. null = não há previsão (humano
// já respondeu, plantão desligado, ou sem âncora).
function proximaAvaliacaoEm({ agora, ultimaMensagemHumanaEm = null, ultimaMensagemClienteEm = null, config = null } = {}) {
  const cfg = resolverConfig(config);
  const now = toDate(agora);
  if (!cfg.ativo || !now) return null;
  const humano = toDate(ultimaMensagemHumanaEm);
  const cliente = toDate(ultimaMensagemClienteEm);
  if (humano && cliente && humano.getTime() >= cliente.getTime()) return null;
  if (deveResponderAgora({ agora: now, ultimaMensagemHumanaEm, ultimaMensagemClienteEm, config })) return now;
  const ancora = cliente || humano;
  if (!ancora) return null;
  return new Date(ancora.getTime() + cfg.esperaMinutos * 60000);
}

module.exports = {
  deveResponderAgora, proximaAvaliacaoEm, emHorarioNoturno, resolverConfig,
  parseHHMM, minutosDoDiaBRT, DEFAULTS, TIMEZONE,
};
