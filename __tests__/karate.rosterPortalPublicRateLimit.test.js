// ============================================================
// AURA KARATÊ — QA H5: rate limit dedicado no portal público (sensei)
//
// POST /:token/practitioner e GET /:token/practitioner-requests herdavam
// só o globalLimiter genérico (300/min por IP) — quem tem o link (pode
// vazar num print de WhatsApp) conseguia inundar a fila de moderação da
// federação com solicitações de identidades distintas. Este teste não
// exercita o estouro do limite em si (os limiters usam
// skip: () => isTestEnv(), mesmo padrão de fpktLookupLimiter, então em
// NODE_ENV=test eles nunca bloqueiam — testar o 429 de verdade exigiria
// derrubar esse skip só para este arquivo, o que criaria um segundo
// comportamento de ambiente para manter). Em vez disso, garante que o
// middleware de rate limit está de fato REGISTRADO na cadeia da rota —
// a regressão que a H5 corrige era justamente a ausência desse middleware.
// ============================================================
'use strict';

const router = require('../src/routes/karateRosterPortalPublic');

function handlersFor(method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`Rota não encontrada: ${method.toUpperCase()} ${path}`);
  return layer.route.stack;
}

describe('karateRosterPortalPublic — rate limit dedicado (QA H5)', () => {
  it('POST /:token/practitioner tem um middleware extra antes do handler (o limiter dedicado)', () => {
    const stack = handlersFor('post', '/:token/practitioner');
    // Antes da correção: só 1 handler (o próprio route handler).
    // Depois: limiter + handler.
    expect(stack.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /:token/practitioner-requests tem um middleware extra antes do handler (limiter reusado do lookup)', () => {
    const stack = handlersFor('get', '/:token/practitioner-requests');
    expect(stack.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /:token/fpkt-lookup continua com seu limiter original (fpktLookupLimiter) intacto', () => {
    const stack = handlersFor('get', '/:token/fpkt-lookup');
    expect(stack.length).toBeGreaterThanOrEqual(2);
  });

  it('POST /:token/practitioner e GET /:token/practitioner-requests não usam o mesmo limiter (criação é mais restritiva que leitura)', () => {
    // Não são o mesmo objeto: o GET de listagem reusa fpktLookupLimiter,
    // o POST de criação usa practitionerCreateLimiter (mais restritivo,
    // 30/10min vs 60/10min) — confirma que não veio o MESMO limiter para
    // os dois por engano (o de criação precisa ser mais apertado).
    const postFn = handlersFor('post', '/:token/practitioner')[0].handle;
    const getFn = handlersFor('get', '/:token/practitioner-requests')[0].handle;
    expect(postFn).not.toBe(getFn);
  });
});
