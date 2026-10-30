// ============================================================
// AURA. — Gate da Equipe: plano com equipe OU acesso extra pago
//
// 30/10/2026 (Doce Encanto): o mount de /members exigia Negocio ou
// Expansao, entao a loja Essencial com acesso extra pago
// (companies.extra_seats_granted, Gestao Aura) via a tela da Equipe
// liberada no app, mas todo pedido voltava 403 "Plano atual nao inclui
// esta funcionalidade". O app ja libera por capacidade desde 12/05
// (configuracoes.tsx, hasTeamCapacity); aqui o backend passa a ler igual.
//
// Sem acesso extra a resposta e a mesma do requirePlan. Se a leitura
// falhar, nega (o helper devolve 0).
// ============================================================
const { getExtraSeatsForCompany } = require('../services/extraSeats');

function planoOuAssentoExtra(...plans) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (plans.includes(req.user.plan)) return next();

    const companyId = req.params && req.params.id;
    if (companyId) {
      let extra = 0;
      try { extra = await getExtraSeatsForCompany(companyId); } catch (_) { extra = 0; }
      if (extra > 0) return next();
    }
    return res.status(403).json({ error: 'Plano atual não inclui esta funcionalidade', required_plans: plans, current_plan: req.user.plan });
  };
}

module.exports = { planoOuAssentoExtra };
