// ============================================================
// AURA. — Limite de "Corrigir meu e-mail" (26/10/2026)
//
// POST /auth/corrigir-email troca o e-mail de quem ainda nao confirmou e
// dispara um e-mail novo. Sem teto, a rota viraria (a) um jeito de mandar
// e-mail da Aura para qualquer endereco e (b) um jeito de descobrir quais
// e-mails ja tem conta (o 409 diz que o e-mail esta em uso). Teto: 5
// tentativas por hora por IP e 5 por hora por usuario. Conta toda
// tentativa, nao so as que dao certo.
//
// ORDEM IMPORTA (licao do tq-71, PR #904): limitador registrado depois da
// rota nunca roda. Por isso:
//   - porIp e montado em src/app.js ANTES do apiRouter;
//   - porUsuario entra na cadeia da propria rota, logo depois do
//     requireAuth (precisa do req.user) e antes do handler.
// Os dois se desligam em NODE_ENV=test, como os outros limitadores; o
// teste deles sobe o app com NODE_ENV=development
// (__tests__/corrigirEmail.limite.test.js).
// ============================================================
const rateLimit = require('express-rate-limit');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();

const JANELA_MS = 60 * 60 * 1000;
const MAXIMO = 5;
const MENSAGEM = {
  error: 'Você tentou trocar o e-mail muitas vezes. Espere um pouco e tente de novo, ou fale com a gente.',
  code: 'CORRIGIR_EMAIL_LIMITE',
};

const porIp = rateLimit({
  windowMs: JANELA_MS,
  max: MAXIMO,
  message: MENSAGEM,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
});

const porUsuario = rateLimit({
  windowMs: JANELA_MS,
  max: MAXIMO,
  message: MENSAGEM,
  standardHeaders: true,
  legacyHeaders: false,
  // So roda depois do requireAuth: req.user.id sempre existe aqui.
  keyGenerator: (req) => 'usuario:' + String(req.user && req.user.id),
  skip: () => env.NODE_ENV === 'test',
});

module.exports = { porIp, porUsuario, JANELA_MS, MAXIMO };
