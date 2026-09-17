// ============================================================
// AURA. — Calculo de proximo aniversario (1.2, aniversariantes odonto)
//
// Puro em JS (sem banco) pra ser testavel isoladamente.
//
// Regras:
//  - Considera virada de ano: se o aniversario deste ano ja passou (ou nao
//    existe mais no calendario deste ano — ver 29/02), usa o do ano seguinte.
//  - 29/02: em ano nao-bissexto cai em 28/02 (ultimo dia valido do mes),
//    mesma convencao de "aniversario antecipado" usada em apps de calendario
//    em geral.
//  - Trabalha só com a parte de data (sem horario), em UTC internamente pra
//    nao sofrer de bug de fuso horario nas contas — quem decide "qual e o
//    dia de hoje" é o chamador (passar `today` já em America/Sao_Paulo).
// ============================================================

function toDateOnly(input) {
  if (input instanceof Date) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const str = String(input).slice(0, 10); // aceita 'YYYY-MM-DD' ou ISO completo
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Ultimo dia valido de um mes/ano (1-indexed month). Usado pra "rebaixar"
// 29/02 -> 28/02 em ano nao-bissexto.
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Retorna a string 'YYYY-MM-DD' correspondente a "hoje" num timezone dado.
// Usado pra nao depender do fuso horario da sessao do Postgres/processo Node.
function todayInTimeZone(timeZone = 'America/Sao_Paulo', ref = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(ref); // en-CA -> 'YYYY-MM-DD'
}

// Dias inteiros ate o proximo aniversario de birthDate, partindo de `today`
// (ambos aceitam Date ou string 'YYYY-MM-DD'). 0 = aniversario e hoje.
// Retorna null se birthDate for invalido/ausente.
function daysUntilNextBirthday(birthDate, today = new Date()) {
  if (!birthDate) return null;

  const b = toDateOnly(birthDate);
  const t = toDateOnly(today);
  if (isNaN(b.getTime()) || isNaN(t.getTime())) return null;

  const month = b.getUTCMonth() + 1; // 1-12
  const day = b.getUTCDate();

  function birthdayInYear(year) {
    const safeDay = Math.min(day, lastDayOfMonth(year, month));
    return new Date(Date.UTC(year, month - 1, safeDay));
  }

  let candidate = birthdayInYear(t.getUTCFullYear());
  if (candidate.getTime() < t.getTime()) {
    candidate = birthdayInYear(t.getUTCFullYear() + 1);
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((candidate.getTime() - t.getTime()) / MS_PER_DAY);
}

module.exports = {
  daysUntilNextBirthday,
  todayInTimeZone,
  toDateOnly,
  isLeapYear,
  lastDayOfMonth,
};
