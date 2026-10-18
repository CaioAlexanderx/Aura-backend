// ============================================================
// AURA. — Uso da impressão de etiqueta (card tq-23, 18/10/2026)
//
// A impressão é um GET que devolve HTML e não grava nada. Para o painel da
// Gestão Aura medir o uso, cada abertura vira +1 em label_print_days
// (empresa, dia de Brasília), com o total de etiquetas pedidas. Sem produto,
// sem nome, sem preço.
//
// FIRE-AND-FORGET: registrarImpressao() devolve já, nunca lança e nunca
// espera o banco. Tabela ainda não criada (42P01) ou qualquer outra falha só
// vira um aviso no log (uma vez por mensagem). A impressão não pode cair por
// causa de telemetria — e o HTML devolvido não muda em nada.
// ============================================================
'use strict';

const SQL = `INSERT INTO label_print_days (company_id, dia, prints, labels, last_at)
     VALUES ($1, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date, 1, $2, NOW())
     ON CONFLICT (company_id, dia) DO UPDATE SET
       prints  = label_print_days.prints + 1,
       labels  = label_print_days.labels + EXCLUDED.labels,
       last_at = NOW()`;

const _avisados = new Set();

// A rota já limita qty a 200; aqui só garante um inteiro são.
function etiquetasPedidas(qty) {
  const n = parseInt(qty, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 1;
}

function registrarImpressao(pool, { companyId, qty }) {
  try {
    if (!companyId) return;
    Promise.resolve(pool.query(SQL, [companyId, etiquetasPedidas(qty)])).catch((err) => {
      const msg = err && err.message;
      if (!_avisados.has(msg)) {
        _avisados.add(msg);
        console.warn('[etiquetaUso] impressao nao registrada:', msg);
      }
    });
  } catch (err) {
    // pool.query lançando de forma síncrona (mock, pool encerrado): ignora.
  }
}

module.exports = { registrarImpressao, etiquetasPedidas, SQL };
