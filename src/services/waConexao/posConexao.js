// ============================================================
// AURA. — O que o servidor faz sozinho depois da janela do Facebook
//
// A lojista não aperta nada: registrar o número e assinar os eventos já
// aconteceram no connect; aqui entram o perfil do WhatsApp (foto, descrição,
// endereço, site) e o preparo dos modelos. Cada item vira ✓ (ou erro) no
// progresso que a tela consulta. Item que falha NÃO derruba os outros.
// ============================================================
'use strict';

const progresso = require('./progresso');
const { causaDoErro } = require('./causas');

async function rodar(companyId, item, fn, { recusaNeutra = false } = {}) {
  await progresso.registrarItem(companyId, item, 'rodando');
  try {
    const r = await fn();
    if (r && r.ok === false && !r.pulado) {
      await progresso.registrarItem(companyId, item, 'erro', { causa: 'outro', codigo: String(r.erro || 'sem-codigo') });
      return false;
    }
    await progresso.registrarItem(companyId, item, 'ok', { campos: r && r.campos });
    return true;
  } catch (e) {
    const { causa, codigo } = causaDoErro(e);
    // A Meta recusou mexer no perfil de número que roda no app do celular
    // (coexistência): não é falha da Aura, a lojista faz pelo celular.
    if (recusaNeutra && e && e.meta) {
      console.warn(`[waConexao] item ${item} indisponível company=${companyId} codigo=${codigo}`);
      await progresso.registrarItem(companyId, item, 'indisponivel', { causa, codigo });
      return true;
    }
    console.warn(`[waConexao] item ${item} falhou company=${companyId} codigo=${codigo}: ${String(e.message).slice(0, 120)}`);
    await progresso.registrarItem(companyId, item, 'erro', { causa, codigo });
    return false;
  }
}

async function marcar(companyId, item, ok, codigoErro) {
  if (ok) await progresso.registrarItem(companyId, item, 'ok');
  else await progresso.registrarItem(companyId, item, 'erro', { causa: 'outro', codigo: codigoErro });
  return ok;
}

/**
 * @param {object} c { registered, subscribed, coexistence, wabaId, phoneNumberId, accessToken }
 * accessToken só vive em memória aqui; nunca é logado.
 */
async function executar(companyId, c, deps = {}) {
  const perfil = deps.perfil || require('./perfil');
  const modelos = deps.modelos || (() => require('../waAutomaticas/modelosStore'));

  // 1 e 2: já feitos (ou não) pelo connect.
  const okNumero = await marcar(companyId, 'numero', !!c.registered, 'nao-registrado');
  const okEventos = await marcar(companyId, 'eventos', !!c.subscribed, 'sem-assinatura');

  // 3: perfil. Sem número não há onde pôr.
  let okPerfil = false;
  if (c.phoneNumberId) {
    okPerfil = await rodar(companyId, 'perfil', () =>
      perfil.aplicarPerfil(companyId, { phoneNumberId: c.phoneNumberId, accessToken: c.accessToken }, deps),
    { recusaNeutra: !!c.coexistence });
  } else {
    await marcar(companyId, 'perfil', false, 'sem-numero');
  }

  // 4: modelos (só com número registrado e WABA).
  let okModelos = false;
  if (c.registered && c.wabaId) {
    okModelos = await rodar(companyId, 'modelos', () =>
      modelos().prepararPadroesSeguro(companyId, { origem: 'conexao' }));
  } else {
    await marcar(companyId, 'modelos', false, 'sem-waba');
  }

  const tudo = okNumero && okEventos && okPerfil && okModelos;
  await progresso.registrarPasso(companyId, null, tudo ? 'pronto' : 'pronto_com_erro', { origem: 'servidor' });
  await progresso.avisarNoSino(companyId, { comErro: !tudo });
  return { okNumero, okEventos, okPerfil, okModelos };
}

/** Dispara sem esperar e sem poder lançar. */
function dispararSeguro(companyId, c, deps) {
  setImmediate(() => {
    executar(companyId, c, deps).catch((e) =>
      console.error(`[waConexao] pós-conexão falhou company=${companyId}: ${String(e.message).slice(0, 120)}`));
  });
}

module.exports = { executar, dispararSeguro };
