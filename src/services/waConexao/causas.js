// ============================================================
// AURA. — Causas dos erros da conexão do WhatsApp (artboard "Conexao",
// momento "Se der errado").
//
// A lojista nunca vê código da Meta: o erro técnico vira UMA das causas
// abaixo, e o app mostra o quadro dela (texto, saída, "Chamar a Aura").
// O código técnico fica no log e no `codigo` que acompanha o "Chamar a
// Aura": nunca em texto de tela.
// ============================================================
'use strict';

const CAUSAS = [
  'janela_fechou',        // fechou a janela antes do fim (só o app sabe)
  'janela_nao_abriu',     // bloqueador de anúncios (só o app sabe)
  'celular_nao_confirmou',
  'numero_em_outro_sistema',
  'facebook_sem_pagina',
  'conexao_caiu',
  'outro',
];

function textoDe(err) {
  return String((err && err.message) || '').toLowerCase();
}

/**
 * Erro (da Graph ou do próprio connect) -> { causa, codigo }.
 * `codigo` é curto e seguro para ir ao suporte: "meta-133010", "http-502".
 */
function causaDoErro(err) {
  const meta = (err && err.meta) || {};
  const code = Number(meta.code);
  const sub = Number(meta.error_subcode);
  const msg = textoDe(err);
  const temCode = Number.isFinite(code) && meta.code != null;
  const codigo = temCode
    ? `meta-${code}${Number.isFinite(sub) && meta.error_subcode != null ? '-' + sub : ''}`
    : (err && err.httpStatus ? `http-${err.httpStatus}` : 'sem-codigo');

  // Credencial recusada/expirada: o código de autorização morreu ou o
  // Facebook mudou a senha.
  if (code === 190 || /session has expired|error validating access token|invalid oauth|authorization code.*(expired|used)/.test(msg)) {
    return { causa: 'conexao_caiu', codigo };
  }
  // Número preso a outra conta/sistema.
  if (/already (registered|in use|connected)|another (account|business|waba|provider)|different (business|account)|in use by another|is associated with/.test(msg)) {
    return { causa: 'numero_em_outro_sistema', codigo };
  }
  // O Facebook que entrou não administra a página/portfólio da loja.
  if (code === 200 || code === 10 ||
      (code === 100 && /permission|business|page|portfolio/.test(msg)) ||
      /(does not have|no) permission|not authorized|business (manager|portfolio)|manage (the )?page/.test(msg)) {
    return { causa: 'facebook_sem_pagina', codigo };
  }
  // Coexistência: o celular não confirmou a tempo.
  if (/qr|confirm|timed? ?out|timeout|expired.*(phone|onboard)|onboarding.*(fail|expired)/.test(msg)) {
    return { causa: 'celular_nao_confirmou', codigo };
  }
  return { causa: 'outro', codigo };
}

module.exports = { CAUSAS, causaDoErro };
