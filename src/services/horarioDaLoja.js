// ============================================================
// AURA. — A loja esta aberta agora? (Canal Digital, 19/10/2026)
//
// Uma regra so, pura, usada pelo selo "Fechada" da vitrine
// (storefrontBuilder.computeOpenState) e pelo aviso de pedido feito com a
// loja fechada (POST /storefront/:slug/order: o pedido entra e a vitrine
// diz quando sera preparado; decisao do Caio, 19/10/2026). Antes o selo era a unica coisa
// que olhava o horario, e olhava errado para quem fecha depois da
// meia-noite: abre 18:00 e fecha 02:00 dava `agora >= 1080 && agora < 120`,
// que nunca e verdade — a adega aparecia Fechada a noite inteira.
//
// Regra da virada: fechamento MENOR que a abertura = fecha no dia
// seguinte. O periodo das 18:00 as 02:00 do sabado vale ate 02:00 do
// domingo, mesmo que o domingo esteja marcado como sem expediente.
//
// O que NAO muda:
//   • sem horario cadastrado = aberta (a maioria das lojas nao preenche);
//   • dia aberto com horario ilegivel = aberta, com erro no log (entre
//     errar pra aberta e errar pra fechada, aberta custa menos);
//   • `always_open` (migration 310) continua sendo decidido por quem chama.
//
// Abertura IGUAL ao fechamento nao e intervalo (seria 0 h ou 24 h?): o
// painel e o PUT do canal recusam salvar; o que ja estiver gravado assim
// e tratado como ilegivel (aberta), pelo mesmo motivo acima.
// ============================================================
'use strict';

const FUSO_PADRAO = 'America/Sao_Paulo';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIA_DA_SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "HH:MM" em minutos desde a meia-noite. Estrito: 24:00 nao passa. */
function parseHHMM(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

/** business_hours cru (objeto ou JSON) -> objeto; qualquer outra coisa -> {}. */
function lerHorarios(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return obj;
}

/**
 * Dia da semana, hora e minuto de `agora` no fuso da loja.
 *
 * `agora` pode ser Date, timestamp em ms ou o formato antigo dos testes
 * ({ hour, minute, dayIndex }, ja no fuso). Sem `agora`, o relogio.
 */
function momentoNoFuso(agora, fuso = FUSO_PADRAO) {
  if (agora && typeof agora === 'object' && !(agora instanceof Date)
      && Number.isInteger(agora.dayIndex)) {
    return { hour: agora.hour, minute: agora.minute, dayIndex: agora.dayIndex };
  }
  const data = agora == null ? new Date() : new Date(agora);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso || FUSO_PADRAO,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const map = {};
  fmt.formatToParts(data).forEach((p) => { map[p.type] = p.value; });
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  return { hour, minute: parseInt(map.minute, 10), dayIndex: DIA_DA_SEMANA[map.weekday] ?? 0 };
}

/**
 * O expediente de um dia, ja interpretado.
 *   null                         dia sem expediente (ou nao cadastrado)
 *   { ilegivel: true }           dia aberto com horario que nao da pra ler
 *   { abre, fecha, viraNoite }   minutos; viraNoite = fecha no dia seguinte
 */
function expedienteDoDia(dia) {
  if (!dia || typeof dia !== 'object' || dia.closed) return null;
  const abre = parseHHMM(dia.open);
  const fecha = parseHHMM(dia.close);
  if (abre == null || fecha == null || abre === fecha) return { ilegivel: true };
  return { abre, fecha, viraNoite: fecha < abre };
}

/**
 * A loja esta aberta neste instante?
 *
 * @param horarios  business_hours: { dom|seg|...: { open, close, closed } }
 * @param agora     Date | ms | { hour, minute, dayIndex }; padrao: agora
 * @param fuso      fuso da loja; padrao America/Sao_Paulo
 * @returns boolean
 */
function estaAberta(horarios, agora, fuso = FUSO_PADRAO) {
  const h = lerHorarios(horarios);
  if (!Object.keys(h).length) return true;

  const { hour, minute, dayIndex } = momentoNoFuso(agora, fuso);
  const minutos = hour * 60 + minute;

  const hoje = expedienteDoDia(h[DIAS[dayIndex]]);
  if (hoje && hoje.ilegivel) {
    console.error('[storefront] horario ilegivel em', DIAS[dayIndex], h[DIAS[dayIndex]]);
    return true;
  }
  if (hoje) {
    if (!hoje.viraNoite && minutos >= hoje.abre && minutos < hoje.fecha) return true;
    if (hoje.viraNoite && minutos >= hoje.abre) return true;
  }

  // A parte da madrugada do expediente de ontem (18:00 -> 02:00).
  const ontem = expedienteDoDia(h[DIAS[(dayIndex + 6) % 7]]);
  if (ontem && !ontem.ilegivel && ontem.viraNoite && minutos < ontem.fecha) return true;

  return false;
}

/**
 * Validacao do horario que a lojista quer SALVAR. Devolve a lista de
 * problemas (vazia = ok). So olha os dias marcados como abertos.
 *
 * `anterior` e o horario ja gravado: um dia que chega IGUAL ao gravado
 * passa mesmo invalido. Assim quem ja tem horario salvo continua
 * conseguindo salvar o resto do formulario; so a edicao nova e barrada.
 */
function problemasDoHorario(horarios, anterior) {
  const h = lerHorarios(horarios);
  const antes = lerHorarios(anterior);
  const problemas = [];
  for (const dia of DIAS) {
    const d = h[dia];
    if (!d || typeof d !== 'object' || d.closed) continue;
    const a = antes[dia];
    if (a && typeof a === 'object' && a.open === d.open && a.close === d.close && !a.closed) continue;
    const abre = parseHHMM(d.open);
    const fecha = parseHHMM(d.close);
    if (abre == null || fecha == null) {
      problemas.push({ dia, motivo: 'formato' });
    } else if (abre === fecha) {
      problemas.push({ dia, motivo: 'igual' });
    }
  }
  return problemas;
}

const NOME_DO_DIA = {
  dom: 'domingo', seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sábado',
};

/** Mensagem unica para o 400 do PUT do canal. */
function mensagemDosProblemas(problemas) {
  if (!problemas.length) return '';
  const p = problemas[0];
  const dia = NOME_DO_DIA[p.dia] || p.dia;
  if (p.motivo === 'igual') {
    return `Horário de ${dia}: o fechamento não pode ser igual à abertura. `
      + 'Se a loja fecha depois da meia-noite, use o horário do dia seguinte (ex.: 18:00 às 02:00). '
      + 'Para receber pedidos a qualquer hora, ligue "Sempre aberta".';
  }
  return `Horário de ${dia} inválido: use HH:MM, de 00:00 a 23:59.`;
}

module.exports = {
  FUSO_PADRAO, DIAS, parseHHMM, lerHorarios, momentoNoFuso, expedienteDoDia,
  estaAberta, problemasDoHorario, mensagemDosProblemas,
};
