// ============================================================
// AURA. — Prazo de cancelamento da nota da venda, por UF (17/11/2026)
// Card b-troca-prazo-nfce.
//
// Antes havia duas regras que não conversavam:
//   - a troca do Caixa escolhia "cancela e reemite" com NFC-e de até 24 h;
//   - o cancelamento da NFC-e da emissão própria recusava depois de 30 min
//     (NFCE_CANCEL_DEADLINE_MIN, fixo, "regra SEFAZ-SP").
// Uma troca entre 30 min e 24 h tentava cancelar e era recusada. Agora as
// duas (e o detalhe da venda, o Editar venda e o cancelar venda) leem o
// MESMO prazo, por UF, daqui.
//
// Prazo da NFC-e (modelo 65), conferido em fonte oficial em 17/11/2026:
//   - Nacional: Ajuste SINIEF 19/2016, cláusula décima quinta, redação do
//     Ajuste SINIEF 7/2018 (efeitos a partir de 01/10/2018): "em prazo não
//     superior a 30 minutos", contado da Autorização de Uso, podendo ser
//     REDUZIDO por cada UF. Nenhuma UF pode dar mais que 30 min.
//     https://www.confaz.fazenda.gov.br/legislacao/ajustes/2016/AJ_019_16
//   - SP: Portaria CAT 12/2015, art. 14, redação da Portaria CAT 83/2018:
//     30 minutos.
//     https://legislacao.fazenda.sp.gov.br/Paginas/Portaria-CAT-12-de-2015.aspx
//   - MG: RICMS/MG 2023 (Decreto 48.589/2023), Anexo V, Parte 1, art. 40:
//     "prazo não superior ao previsto no Ajuste SINIEF 19/16" = 30 minutos.
//     https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/ricms_2023_seco/anexov2023_2.html
//   - RJ: Resolução SEFAZ 720/2014, Parte II, Anexo II-A, redação da
//     Resolução SEFAZ 349/2018: 30 minutos (antes 24 h).
//   - AP: sem redução estadual encontrada; vale o teto nacional, 30 minutos.
//   - BA (23/11/2026): RICMS-BA (Decreto 13.780/2012), art. 107-H, I, incluído
//     pelo Decreto 19.142/2019: "em até 30 (trinta) minutos, quando emitida
//     com incorreção e não tiver ocorrido a circulação da mercadoria". O
//     inciso II (168 h quando outra NFC-e em contingência acobertou a mesma
//     operação) é o cancelamento da nota duplicada pela contingência, não o
//     da venda — fica fora desta tabela.
//     https://www.legisweb.com.br/legislacao/?id=380821
// Fora do prazo a SEFAZ recusa com cStat 501 ("Prazo de cancelamento superior
// ao previsto na Legislação"). O caminho é a NF-e de devolução (modelo 55,
// finalidade 4), que já existe (services/trocaDevolucao55.js).
//
// NF-e modelo 55 (tipo 'nfe'): o prazo continua o de services/nfe55Eventos.js
// (24 h, NFE55_CANCEL_DEADLINE_H). Ele só é lido daqui para o cancelar venda.
//
// NFCE_CANCEL_DEADLINE_MIN: continua valendo como alavanca de operação (vale
// para todas as UFs quando preenchido com número positivo). Sem ele, a tabela.
// ============================================================
'use strict';

const PRAZO_NACIONAL_MIN = 30;

const PRAZO_NFCE_POR_UF = Object.freeze({
  SP: Object.freeze({ minutos: 30, fonte: 'Portaria CAT 12/2015, art. 14 (redação da Portaria CAT 83/2018)' }),
  AP: Object.freeze({ minutos: 30, fonte: 'Ajuste SINIEF 19/2016, cláusula décima quinta (redação do Ajuste SINIEF 7/2018)' }),
  RJ: Object.freeze({ minutos: 30, fonte: 'Resolução SEFAZ 720/2014, Parte II, Anexo II-A (redação da Resolução SEFAZ 349/2018)' }),
  MG: Object.freeze({ minutos: 30, fonte: 'RICMS/MG 2023, Anexo V, Parte 1, art. 40 (prazo do Ajuste SINIEF 19/2016)' }),
  BA: Object.freeze({ minutos: 30, fonte: 'RICMS-BA (Decreto 13.780/2012), art. 107-H, I (incluído pelo Decreto 19.142/2019)' }),
});

// Código IBGE da UF (os dois primeiros dígitos da chave de acesso).
const UF_DO_CUF = Object.freeze({
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO',
  21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA',
  31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP',
  41: 'PR', 42: 'SC', 43: 'RS',
  50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
});

function normUf(uf) {
  const u = String(uf || '').toUpperCase().trim();
  return /^[A-Z]{2}$/.test(u) ? u : null;
}

/** UF da nota: a da chave de acesso (quem emitiu), senão a da configuração, senão SP. */
function ufDaNota(nota, ufConfig) {
  const chave = String((nota && nota.chave_acesso) || '');
  if (/^\d{44}$/.test(chave)) {
    const uf = UF_DO_CUF[parseInt(chave.slice(0, 2), 10)];
    if (uf) return uf;
  }
  return normUf(ufConfig) || normUf(nota && (nota.uf || nota.config_uf)) || 'SP';
}

function ehModelo55(nota) {
  if (!nota) return false;
  const chave = String(nota.chave_acesso || '');
  if (/^\d{44}$/.test(chave)) return chave.slice(20, 22) === '55';
  return nota.tipo === 'nfe' || nota.tipo === 'nfe_devolucao';
}

/** Minutos do prazo da NFC-e na UF. */
function minutosDoPrazoNfce(uf, env = process.env) {
  const override = parseInt(String((env && env.NFCE_CANCEL_DEADLINE_MIN) || ''), 10);
  if (Number.isFinite(override) && override > 0) return override;
  const linha = PRAZO_NFCE_POR_UF[normUf(uf) || ''];
  return linha ? linha.minutos : PRAZO_NACIONAL_MIN;
}

function horasDoPrazo55(env = process.env) {
  const h = Number(String((env && env.NFE55_CANCEL_DEADLINE_H) || '').replace(',', '.'));
  return Number.isFinite(h) && h > 0 ? h : 24;
}

/**
 * Até quando a nota pode ser cancelada.
 * @returns {{ modelo: '65'|'55', uf: string, minutos: number, ate: string|null,
 *             dentro: boolean, vencido: boolean, desconhecido: boolean }}
 *   desconhecido = sem authorized_at: não dá para afirmar o prazo. Quem chama
 *   decide (a troca vai para a devolução; o POST /cancel deixa a SEFAZ decidir).
 */
function prazoDeCancelamento(nota, { uf, now = Date.now(), env = process.env } = {}) {
  const modelo = ehModelo55(nota) ? '55' : '65';
  const ufNota = ufDaNota(nota, uf);
  const minutos = modelo === '55' ? Math.round(horasDoPrazo55(env) * 60) : minutosDoPrazoNfce(ufNota, env);
  const aut = nota && nota.authorized_at ? new Date(nota.authorized_at).getTime() : NaN;
  if (!Number.isFinite(aut)) {
    return { modelo, uf: ufNota, minutos, ate: null, dentro: false, vencido: false, desconhecido: true };
  }
  const ate = aut + minutos * 60000;
  const t = typeof now === 'number' ? now : new Date(now).getTime();
  return {
    modelo, uf: ufNota, minutos,
    ate: new Date(ate).toISOString(),
    dentro: t <= ate,
    vencido: t > ate,
    desconhecido: false,
  };
}

/**
 * Caminho fiscal da troca para UMA venda de origem.
 *   - sem NFC-e autorizada            → 'none'
 *   - NFC-e do gateway, dentro do prazo → 'cancel_reissue' (cancela no gateway)
 *   - qualquer outro caso              → 'devolucao_55'  (vale em qualquer idade)
 * A NFC-e da emissão própria vai sempre para a devolução: o cancelamento dela
 * pela troca não existe (12/08/2026) e o cancelamento na SEFAZ não tem volta
 * se a transação da troca falhar depois.
 */
function estrategiaDaTroca(nota, opts = {}) {
  if (!nota) return 'none';
  const prazo = prazoDeCancelamento(nota, opts);
  if (nota.nuvemfiscal_id && prazo.dentro) return 'cancel_reissue';
  return 'devolucao_55';
}

/**
 * Prévia do caminho fiscal da troca para a lista de vendas do Caixa
 * (GET /pdv/sales-for-troca e /pdv/sales-by-product-barcode). O app mostra o
 * que o servidor vai fazer, em vez de adivinhar pela idade da venda.
 * @param nota { authorized_at, chave_acesso, nuvemfiscal_id, config_uf } | null
 */
function previaFiscalDaTroca(nota, opts = {}) {
  if (!nota) {
    return { nfce_authorized_at: null, nfce_uf: null, nfce_prazo_minutos: null, nfce_cancelavel_ate: null, nfce_troca_estrategia: 'none' };
  }
  const prazo = prazoDeCancelamento(nota, { uf: nota.config_uf, ...opts });
  return {
    nfce_authorized_at: nota.authorized_at || null,
    nfce_uf: prazo.uf,
    nfce_prazo_minutos: prazo.minutos,
    nfce_cancelavel_ate: prazo.ate,
    nfce_troca_estrategia: estrategiaDaTroca(nota, { uf: nota.config_uf, ...opts }),
  };
}

/** Subselect (SQL) da NFC-e autorizada mais recente da venda `s`, para a prévia. */
const SQL_NFCE_DA_TROCA = `(SELECT json_build_object('authorized_at', nf.authorized_at, 'chave_acesso', nf.chave_acesso,
          'nuvemfiscal_id', nf.nuvemfiscal_id,
          'config_uf', (SELECT nc.uf FROM nfce_config nc WHERE nc.company_id = nf.company_id))
         FROM nfce_emissions nf WHERE nf.sale_id = s.id AND nf.tipo = 'nfce' AND nf.status = 'autorizada'
        ORDER BY nf.created_at DESC LIMIT 1) AS nfce_da_troca`;

module.exports = {
  previaFiscalDaTroca,
  SQL_NFCE_DA_TROCA,
  PRAZO_NACIONAL_MIN,
  PRAZO_NFCE_POR_UF,
  UF_DO_CUF,
  ufDaNota,
  ehModelo55,
  minutosDoPrazoNfce,
  prazoDeCancelamento,
  estrategiaDaTroca,
};
