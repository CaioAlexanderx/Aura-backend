// ============================================================
// AURA KARATÊ — Deduplicação de praticante (H1)
//
// Filosofia (fechada com o Caio): "com base ruim, bloquear automaticamente
// é pior que duplicar". Este módulo SUGERE possíveis correspondências —
// NUNCA decide, nunca bloqueia um cadastro/aprovação sozinho. Quem decide
// é sempre a federação, olhando a lista de possíveis matches.
//
// Pesos das chaves (conferidos em produção, 14/07/2026 — 9.608 praticantes):
//   1) número FPKT informado  — identificador forte, quando presente (100)
//   2) nome + data de nascimento — nascimento existe em 96% dos praticantes,
//      é a espinha dorsal do match (70)
//   3) RG — presente em 66% (40)
//   4) CPF — presente em só 28%; reforço, JAMAIS chave principal (20)
//
// Nome é sempre normalizado (maiúsculas, sem acento, espaços colapsados)
// antes de comparar — a base tem lixo de import (acentuação inconsistente,
// espaços duplos). unaccent() do Postgres é STABLE, não IMMUTABLE, então a
// normalização roda aqui em JS (não em índice funcional/coluna gerada).
// ============================================================
'use strict';

const SCORE = Object.freeze({
  fpkt_number: 100,
  name_birthdate: 70,
  rg: 40,
  cpf: 20,
});

// Remove acento, caixa alta, colapsa espaços. Mesma filosofia de
// normalizeName() em src/routes/productsDuplicates.js, mas com remoção de
// acento (aqui é necessária — nome de praticante tem muito mais lixo de
// import histórico do que nome de produto).
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizeFpktNumber(v) {
  return String(v || '').trim();
}

// Chave de deduplicação/idempotência da SOLICITAÇÃO — dojô + nome
// normalizado + nascimento (nascimento cobre 96% dos casos; quando ausente,
// a chave ainda funciona, só fica mais permissiva a colisão de nomes iguais
// sem nascimento informado, o que é aceitável: pior caso é o sensei ter que
// usar um nome levemente diferente, nunca perda de dado).
function buildDedupKey(fullName, birthDate) {
  const namePart = normalizeName(fullName);
  const datePart = birthDate ? String(birthDate).slice(0, 10) : '';
  return `${namePart}|${datePart}`;
}

// Busca candidatos na federação que batem em QUALQUER uma das chaves
// (FPKT exato, nascimento igual, RG normalizado igual ou CPF normalizado
// igual) — narrowing em SQL, scoring fino em JS. LIMIT alto o bastante
// para não perder candidato real, baixo o bastante para não escanear a
// federação inteira à toa.
async function findPossibleMatches(db, { federationId, fullName, birthDate, rg, cpf, fpktNumberClaimed, excludePractitionerId = null }) {
  const fpkt = fpktNumberClaimed ? normalizeFpktNumber(fpktNumberClaimed) : null;
  const rgDigits = digitsOnly(rg);
  const cpfDigits = digitsOnly(cpf);
  const birth = birthDate ? String(birthDate).slice(0, 10) : null;

  if (!fpkt && !birth && !rgDigits && !cpfDigits) {
    // Sem nenhuma chave forte pra buscar — nome sozinho não basta (regra
    // de negócio explícita: nome sozinho gera falso positivo demais numa
    // base com lixo de import). Não retorna nada, mas isso é esperado: a
    // UI mostra "sem correspondência sugerida", não é erro.
    return [];
  }

  const { rows } = await db.query(
    `SELECT c.id, c.name, c.karate_registration_number, c.birth_date, c.rg, c.cpf_cnpj,
            c.dojo_id, comp.name AS dojo_name
       FROM customers c
       LEFT JOIN companies comp ON comp.id = c.dojo_id
      WHERE c.federation_id = $1
        AND ($2::uuid IS NULL OR c.id <> $2)
        AND (
          ($3::text IS NOT NULL AND c.karate_registration_number = $3)
          OR ($4::date IS NOT NULL AND c.birth_date = $4)
          OR ($5::text <> '' AND regexp_replace(COALESCE(c.rg, ''), '\\D', '', 'g') = $5)
          OR ($6::text <> '' AND regexp_replace(COALESCE(c.cpf_cnpj, ''), '\\D', '', 'g') = $6)
        )
      LIMIT 50`,
    [federationId, excludePractitionerId, fpkt, birth, rgDigits, cpfDigits]
  );

  const normalizedTargetName = normalizeName(fullName);

  const scored = rows.map((r) => {
    const matchedOn = [];
    let score = 0;

    if (fpkt && r.karate_registration_number && normalizeFpktNumber(r.karate_registration_number) === fpkt) {
      matchedOn.push('fpkt_number');
      score += SCORE.fpkt_number;
    }

    const candidateBirth = r.birth_date ? String(r.birth_date).slice(0, 10) : null;
    const candidateName = normalizeName(r.name);
    if (birth && candidateBirth === birth && normalizedTargetName && candidateName === normalizedTargetName) {
      matchedOn.push('name_birthdate');
      score += SCORE.name_birthdate;
    }

    if (rgDigits && digitsOnly(r.rg) === rgDigits) {
      matchedOn.push('rg');
      score += SCORE.rg;
    }

    if (cpfDigits && digitsOnly(r.cpf_cnpj) === cpfDigits) {
      matchedOn.push('cpf');
      score += SCORE.cpf;
    }

    return {
      practitioner_id: r.id,
      name: r.name,
      karate_registration_number: r.karate_registration_number || null,
      dojo_id: r.dojo_id || null,
      dojo_name: r.dojo_name || null,
      matched_on: matchedOn,
      score,
      // 'high': FPKT exato OU nome+nascimento batem — confiança forte.
      // 'medium': só RG bateu. 'low': só CPF bateu (reforço, nunca chave
      // principal — 28% de cobertura só, muito ruído sozinho).
      confidence: matchedOn.includes('fpkt_number') || matchedOn.includes('name_birthdate')
        ? 'high'
        : (matchedOn.includes('rg') ? 'medium' : 'low'),
    };
  })
    // Candidatos que entraram pelo WHERE (ex.: só nascimento bateu, mas o
    // nome é totalmente diferente) e não acumularam NENHUM score (score=0)
    // não são um "possível match" de verdade — nascimento sozinho sem nome
    // batendo é coincidência (data de nascimento não é identificador).
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5);
}

// Dado um número FPKT, diz se já pertence a alguém na federação — usado
// pelo endpoint "auto-localizar" do portal do sensei. Se pertence, é
// TRANSFERÊNCIA, não criação — a resposta deixa isso explícito.
async function lookupByFpktNumber(db, { federationId, number }) {
  const normalized = normalizeFpktNumber(number);
  if (!normalized) return { found: false };

  const { rows } = await db.query(
    `SELECT c.id, c.name, c.dojo_id, comp.name AS dojo_name, c.is_active
       FROM customers c
       LEFT JOIN companies comp ON comp.id = c.dojo_id
      WHERE c.federation_id = $1 AND c.karate_registration_number = $2
      LIMIT 1`,
    [federationId, normalized]
  );

  if (!rows.length) return { found: false };

  const p = rows[0];
  return {
    found: true,
    is_transfer: true,
    message: 'Este número FPKT já pertence a um praticante cadastrado. Isto é uma TRANSFERÊNCIA, não uma criação.',
    practitioner: {
      id: p.id,
      name: p.name,
      current_dojo_id: p.dojo_id || null,
      current_dojo_name: p.dojo_name || null,
      is_active: p.is_active !== false,
    },
  };
}

module.exports = {
  SCORE,
  normalizeName,
  digitsOnly,
  normalizeFpktNumber,
  buildDedupKey,
  findPossibleMatches,
  lookupByFpktNumber,
};
