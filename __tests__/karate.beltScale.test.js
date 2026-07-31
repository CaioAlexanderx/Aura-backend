// ============================================================
// AURA KARATÊ — F8.0: o dicionário canônico de faixas
//
// Cobre:
//   1. A ESCALA COMPLETA (10 kyus + 10 dans) na ordem oficial da FPKT
//      confirmada em 31/07/2026.
//   2. O BUG que a migration 264 corrige: Azul Claro (6º kyu) vem ANTES
//      de Roxa (5º kyu) — a 229 tinha os dois invertidos.
//   3. A FRONTEIRA DO SENSEI: o dojô gradua até 1º kyu; preta é banca da
//      federação.
//   4. Extração do GRAU dos formatos que existem de verdade no banco
//      ("Preta 1°", "Marrom 3°kyu", "Marrom" sem grau).
//   5. GUARDA-CORPO: o CASE da migration 264 tem que bater com
//      LEVEL_RANK, e nenhum outro arquivo de src/ pode declarar um mapa
//      de faixa próprio (era assim que nasciam os espelhos divergentes).
//
// Teste PURO (sem banco). O comportamento da view em Postgres real está
// em __tests__/karate.beltDegreeAndOrder.test.js.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const scale = require('../src/utils/karateBeltScale');

const ROOT = path.resolve(__dirname, '..');

describe('F8.0 — escala oficial da FPKT', () => {
  test('a escada completa é 10 kyus + 10 dans, na ordem oficial', () => {
    expect(scale.FPKT_LADDER.map((s) => s.label)).toEqual([
      'Branca',
      'Amarela',
      'Laranja',
      'Verde',
      'Azul Claro',
      'Roxa',
      'Azul Escuro',
      'Marrom 3º kyu',
      'Marrom 2º kyu',
      'Marrom 1º kyu',
      'Preta 1º dan',
      'Preta 2º dan',
      'Preta 3º dan',
      'Preta 4º dan',
      'Preta 5º dan',
      'Preta 6º dan',
      'Preta 7º dan',
      'Preta 8º dan',
      'Preta 9º dan',
      'Preta 10º dan',
    ]);
  });

  test('cada cor de kyu único carrega o kyu certo da escala oficial', () => {
    const kyuOf = {};
    for (const step of scale.FPKT_LADDER) {
      if (step.kyu != null && step.level !== 'marrom') kyuOf[step.level] = step.kyu;
    }
    expect(kyuOf).toEqual({
      branca: 10,
      amarela: 9,
      laranja: 8,
      verde: 7,
      azul_claro: 6,
      roxo: 5,
      azul_escuro: 4,
    });
  });

  test('marrom tem TRÊS kyus (3º, 2º, 1º) — é a única cor com mais de um', () => {
    const marrom = scale.COLOR_SCALE.find((c) => c.level === 'marrom');
    expect(marrom.kyus).toEqual([3, 2, 1]);
    const multi = scale.COLOR_SCALE.filter((c) => c.kyus.length > 1).map((c) => c.level);
    expect(multi).toEqual(['marrom']);
  });

  test('o rank cresce monotonicamente do 10º kyu ao 10º dan', () => {
    const ranks = scale.FPKT_LADDER.map((s) => s.rank);
    expect(ranks).toEqual(ranks.slice().sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('F8.0 — o bug da 229: Roxa × Azul Claro', () => {
  test('Azul Claro (6º kyu) vem ANTES de Roxa (5º kyu)', () => {
    expect(scale.levelRankOf('azul_claro')).toBeLessThan(scale.levelRankOf('roxo'));
    expect(scale.beltDisplayRank('azul_claro')).toBeLessThan(scale.beltDisplayRank('roxo'));
  });

  test('regressão explícita: a ordem invertida da 229 (roxo=5, azul_claro=6) NÃO volta', () => {
    expect(scale.LEVEL_RANK.azul_claro).toBe(5);
    expect(scale.LEVEL_RANK.roxo).toBe(6);
    expect(scale.LEVEL_RANK.roxo).not.toBe(5);
    expect(scale.LEVEL_RANK.azul_claro).not.toBe(6);
  });

  test('Roxa (5º kyu) vem antes de Azul Escuro (4º kyu) — o erro do karateFederation.js', () => {
    expect(scale.beltDisplayRank('roxo')).toBeLessThan(scale.beltDisplayRank('azul_escuro'));
  });

  test('a ordem textual dada pelo dono do produto é reproduzida ponta a ponta', () => {
    const cores = ['branca', 'amarela', 'laranja', 'verde', 'azul_claro', 'roxo', 'azul_escuro', 'marrom', 'preta'];
    const embaralhado = cores.slice().reverse();
    expect(embaralhado.slice().sort((a, b) => scale.levelRankOf(a) - scale.levelRankOf(b))).toEqual(cores);
  });

  test('vermelha (legada) fica fora da progressão e fecha a lista de exibição', () => {
    expect(scale.levelRankOf('vermelha')).toBe(0);
    expect(scale.beltDisplayRank('vermelha')).toBe(scale.LEGACY_RED_DISPLAY_RANK);
    expect(scale.beltDisplayRank('vermelha')).toBeGreaterThan(scale.beltDisplayRank('preta', 'Preta 10°'));
    expect(scale.isLegacyOnlyLevel('vermelha')).toBe(true);
  });

  test('faixa desconhecida não vira faixa fantasma no meio da escala', () => {
    expect(scale.beltDisplayRank('faixa_que_nao_existe')).toBe(scale.UNKNOWN_DISPLAY_RANK);
    expect(scale.levelRankOf('faixa_que_nao_existe')).toBeNull();
  });

  test('grau ordena dentro da própria cor: marrom 1º kyu > 2º > 3º; preta 7º dan > 1º dan', () => {
    expect(scale.beltDisplayRank('marrom', { kyu: 1 })).toBeGreaterThan(scale.beltDisplayRank('marrom', { kyu: 2 }));
    expect(scale.beltDisplayRank('marrom', { kyu: 2 })).toBeGreaterThan(scale.beltDisplayRank('marrom', { kyu: 3 }));
    expect(scale.beltDisplayRank('marrom', { kyu: 1 })).toBeLessThan(scale.beltDisplayRank('preta', 'Preta 1°'));
    expect(scale.beltDisplayRank('preta', 'Preta 7°')).toBeGreaterThan(scale.beltDisplayRank('preta', 'Preta 1°'));
  });

  test('marrom sem grau conhecido nunca é promovido por engano — vale o degrau mais baixo da cor', () => {
    expect(scale.beltDisplayRank('marrom', null)).toBe(scale.beltDisplayRank('marrom', { kyu: 3 }));
    expect(scale.beltDisplayRank('marrom', 'Marrom')).toBeLessThan(scale.beltDisplayRank('marrom', { kyu: 1 }));
  });

  test('sinônimos de escrita não viram faixas diferentes', () => {
    expect(scale.normalizeBeltLevel('Roxa')).toBe('roxo');
    expect(scale.normalizeBeltLevel('Azul Claro')).toBe('azul_claro');
    expect(scale.normalizeBeltLevel('azulclaro')).toBe('azul_claro');
    expect(scale.normalizeBeltLevel('AZUL-ESCURO')).toBe('azul_escuro');
    expect(scale.normalizeBeltLevel('Amarela')).toBe('amarela');
    expect(scale.beltDisplayRank('Roxa')).toBe(scale.beltDisplayRank('roxo'));
  });
});

describe('F8.0 — a fronteira do sensei (teto 1º kyu)', () => {
  test('o teto declarado é Marrom 1º kyu', () => {
    expect(scale.DOJO_CEILING).toEqual({ level: 'marrom', kyu: 1, label: 'Marrom 1º kyu' });
  });

  test('o dojô pode conceder todos os 10 kyus e NENHUM dan', () => {
    const grantable = scale.FPKT_LADDER.filter((s) => s.grantable_by_dojo);
    expect(grantable).toHaveLength(10);
    expect(grantable.every((s) => s.kyu != null && s.dan == null)).toBe(true);
    expect(scale.FPKT_LADDER.filter((s) => s.dan != null).every((s) => s.grantable_by_dojo === false)).toBe(true);
  });

  test('canDojoGrant: libera até 1º kyu e barra qualquer preta', () => {
    expect(scale.canDojoGrant({ level: 'marrom', kyu: 1 })).toBe(true);
    expect(scale.canDojoGrant({ level: 'marrom', kyu: 3 })).toBe(true);
    expect(scale.canDojoGrant({ level: 'azul_claro', kyu: 6 })).toBe(true);
    expect(scale.canDojoGrant({ level: 'branca' })).toBe(true);
    expect(scale.canDojoGrant({ level: 'preta', dan: 1 })).toBe(false);
    expect(scale.canDojoGrant({ level: 'preta' })).toBe(false);
    expect(scale.canDojoGrant('preta', 'Preta 1°')).toBe(false);
  });

  test('canDojoGrant barra grau incoerente com a cor e a escala legada', () => {
    expect(scale.canDojoGrant({ level: 'marrom', kyu: 5 })).toBe(false);
    expect(scale.canDojoGrant({ level: 'verde', kyu: 2 })).toBe(false);
    expect(scale.canDojoGrant({ level: 'vermelha' })).toBe(false);
  });

  test('o motivo do teto cita a banca da FPKT (mesma nota do seed da migration 150)', () => {
    expect(scale.DOJO_CEILING_REASON).toMatch(/banca/i);
    expect(scale.DOJO_CEILING_REASON).toMatch(/FPKT/);
  });
});

describe('F8.0 — grau extraído dos formatos que existem no banco', () => {
  test('"Preta 1°" … "Preta 7°" viram dan', () => {
    for (const dan of [1, 2, 3, 4, 5, 6, 7]) {
      expect(scale.parseDegreeFromName('preta', `Preta ${dan}°`)).toEqual({ kyu: null, dan });
    }
  });

  test('"Marrom 3°kyu" / "Marrom 2°kyu" / "Marrom 1°kyu" viram kyu', () => {
    for (const kyu of [3, 2, 1]) {
      expect(scale.parseDegreeFromName('marrom', `Marrom ${kyu}°kyu`)).toEqual({ kyu, dan: null });
    }
  });

  test('"Marrom" sem grau = GRAU DESCONHECIDO (não vira 1º, 2º nem 3º kyu)', () => {
    expect(scale.parseDegreeFromName('marrom', 'Marrom')).toEqual({ kyu: null, dan: null });
    expect(scale.resolveDegree('marrom', 'Marrom', 'fpkt_shotokan')).toEqual({ kyu: null, dan: null, source: null });
  });

  test('cor de kyu único deduz o kyu — e o source diz que veio da COR, não do nome', () => {
    expect(scale.resolveDegree('azul_claro', 'Azul Claro', 'fpkt_shotokan')).toEqual({
      kyu: 6,
      dan: null,
      source: 'color',
    });
    expect(scale.resolveDegree('roxo', 'Roxa', 'fpkt_shotokan')).toEqual({ kyu: 5, dan: null, source: 'color' });
    expect(scale.resolveDegree('branca', 'Branca', 'fpkt_shotokan')).toEqual({ kyu: 10, dan: null, source: 'color' });
    expect(scale.resolveDegree('preta', 'Preta 3°', 'fpkt_shotokan')).toEqual({ kyu: null, dan: 3, source: 'name' });
  });

  test('a escala legacy NÃO deduz kyu por cor — nem para a vermelha', () => {
    expect(scale.kyuFromColor('roxo', 'legacy')).toBeNull();
    expect(scale.kyuFromColor('branca', 'legacy')).toBeNull();
    expect(scale.resolveDegree('roxo', 'Roxa', 'legacy')).toEqual({ kyu: null, dan: null, source: null });
    expect(scale.kyuFromColor('vermelha', 'fpkt_shotokan')).toBeNull();
  });

  test('legacy ainda lê o grau ESCRITO no nome (é fato, não dedução)', () => {
    expect(scale.resolveDegree('marrom', 'Marrom 2°kyu', 'legacy')).toEqual({ kyu: 2, dan: null, source: 'name' });
    expect(scale.resolveDegree('preta', 'Preta 6°', 'legacy')).toEqual({ kyu: null, dan: 6, source: 'name' });
  });

  test('número fora de 1..10 não vira grau', () => {
    expect(scale.parseDegreeFromName('preta', 'Preta 99°')).toEqual({ kyu: null, dan: null });
    expect(scale.parseDegreeFromName('marrom', 'Marrom 0kyu')).toEqual({ kyu: null, dan: null });
  });

  test('rótulos legíveis a partir de cor + grau', () => {
    expect(scale.beltLabel('marrom', { kyu: 1 })).toBe('Marrom 1º kyu');
    expect(scale.beltLabel('marrom', null)).toBe('Marrom');
    expect(scale.beltLabel('preta', { dan: 3 })).toBe('Preta 3º dan');
    expect(scale.beltLabel('preta', null)).toBe('Preta');
    expect(scale.beltLabel('roxo')).toBe('Roxa');
  });
});

describe('F8.0 — guarda-corpo: uma escala só', () => {
  test('o CASE da migration 264 bate exatamente com LEVEL_RANK', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', '264_karate_belt_scale_e_grau.sql'), 'utf8');
    const bloco = sql.split('>>> ESCALA CANONICA')[1];
    expect(bloco).toBeDefined();
    const corpo = bloco.split('<<< ESCALA CANONICA')[0];

    const doSql = {};
    const re = /WHEN\s+'([a-z_]+)'\s+THEN\s+(\d+)/g;
    let m;
    while ((m = re.exec(corpo)) !== null) doSql[m[1]] = parseInt(m[2], 10);

    // o alias 'roxa' existe só no SQL (dado histórico); vale o mesmo que 'roxo'
    expect(doSql.roxa).toBe(doSql.roxo);
    delete doSql.roxa;

    expect(doSql).toEqual(Object.assign({}, scale.LEVEL_RANK));
  });

  test('a pirâmide de karateNetworkHealth.js concorda com a escala canônica', () => {
    // FAIXA_ORDER é o SEXTO espelho encontrado na varredura da F8.0 — e o
    // único que já estava CERTO (azul_claro 5 < roxa 6 < azul_escuro 7).
    // Não foi derivado do módulo de propósito: os slugs dele ('roxa',
    // 'dan1', 'dan2') são contrato com o front e mudá-los quebraria a
    // pirâmide da tela de saúde da rede. Fica pinado por este teste: se
    // alguém mexer numa das duas pontas, o CI acusa.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'karateNetworkHealth.js'), 'utf8');
    const bloco = src.split('const FAIXA_ORDER = [')[1].split('];')[0];

    const ordemPorSlug = {};
    const re = /slug:\s*'([a-z0-9_]+)'[^}]*ordem:\s*(\d+)/g;
    let m;
    while ((m = re.exec(bloco)) !== null) ordemPorSlug[m[1]] = parseInt(m[2], 10);

    // 'roxa' é o slug do front para o belt_level 'roxo'
    const canonico = {};
    for (const [level, rank] of Object.entries(scale.LEVEL_RANK)) {
      if (level === 'vermelha') continue; // fora da pirâmide, como na própria rota
      if (level === 'preta') continue; // vira dan1/dan2 na pirâmide
      canonico[level === 'roxo' ? 'roxa' : level] = rank;
    }
    for (const [slug, rank] of Object.entries(canonico)) {
      expect(ordemPorSlug[slug]).toBe(rank);
    }
    // e os Dan continuam depois de tudo que é kyu
    expect(ordemPorSlug.dan1).toBeGreaterThan(ordemPorSlug.marrom);
    expect(ordemPorSlug.dan2).toBeGreaterThan(ordemPorSlug.dan1);
  });

  test('nenhum outro arquivo de src/ declara um mapa de faixa próprio', () => {
    const ofensores = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (rel === 'src/utils/karateBeltScale.js') continue; // o dono da escala
        const src = fs.readFileSync(full, 'utf8');
        // chave de faixa seguida de peso numérico = mapa de ordenação.
        // 'branca' fica FORA do padrão de propósito: "black_belt_sem_co<b>branca</b>"
        // em karateStandingQueries.js casaria e o guarda viraria ruído.
        if (/\b(azul_claro|azul_escuro|marrom)['"]?\s*:\s*\d+/.test(src)) ofensores.push(rel);
      }
    };
    walk(path.join(ROOT, 'src'));

    expect(ofensores).toEqual([]);
  });
});
