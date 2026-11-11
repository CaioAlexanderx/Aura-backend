// ============================================================
// AURA. — nfseNacional/notaDaAura: a NFS-e gravada numa linha é mesmo da
// Aura? — funções PURAS (sem banco, sem rede).
//
// Por quê (incidente de 10/11/2026, produção): a loja já emitia NFS-e pela
// prefeitura na série 1; a Aura mandou a DPS série 1 nº 1, o gov.br
// respondeu E0014 e a NFS-e ANTIGA de outro emissor (R$ 25,00 de 22/10)
// foi gravada como a nota da venda de R$ 44,00. Uma linha assim não pode
// ser cancelada, nem ter o PDF/XML servido, nem ser "atualizada" pela
// consulta — tudo isso agiria sobre a nota de outra venda.
//
// Ficam aqui (e não em index.js) para a rota do XML usar a mesma regra do
// DANFSe sem depender do orquestrador (que os testes de rota trocam por mock).
// ============================================================
'use strict';

const { lerNfse } = require('./nfseParser');
const { conferirNfseComDps } = require('./conferenciaDps');
const { temDpsNumeroJaUsado } = require('./errors');

/** Id da DPS embutida na NFS-e (infNFSe/DPS/infDPS/@Id), ou null. */
function idDaDpsEmbutida(nfseXml) {
  try {
    const l = lerNfse(nfseXml);
    return l.dps && l.dps.id ? l.dps.id : null;
  } catch (_) {
    return null;
  }
}

const SERVIVEIS = new Set(['autorizada', 'cancelada']);

const MSG_NOTA_DE_OUTRO_EMISSOR = 'Esta nota não foi emitida pela Aura: a série e o número já tinham sido usados '
  + 'por outro emissor desta empresa, e a NFS-e com esse número é a do outro emissor. Nada foi enviado ao gov.br.';

const MSG_NOTA_NAO_CONFERIDA = 'Não conseguimos confirmar que a NFS-e gravada nesta nota é a da DPS que a Aura enviou. '
  + 'Por segurança, nada foi enviado ao gov.br. Fale com o suporte Aura.';

/**
 * A NFS-e gravada na linha (xml_nfse) é da DPS que a Aura assinou (xml_dps)?
 * Nota marcada DPS_NUMERO_JA_USADO é de outro emissor, sem conferir.
 * @returns {{ resultado: 'igual'|'diferente'|'indeterminado', numeroJaUsado: boolean, conf?: object }}
 */
function conferirNotaGravada(row) {
  if (temDpsNumeroJaUsado(row)) return { resultado: 'diferente', numeroJaUsado: true };
  if (!row || !row.xml_nfse || !row.xml_dps) return { resultado: 'indeterminado', numeroJaUsado: false };
  const conf = conferirNfseComDps({ nfseXml: row.xml_nfse, dpsXml: row.xml_dps });
  return { resultado: conf.resultado, numeroJaUsado: false, conf };
}

/**
 * Pode servir o PDF/XML desta nota? Só autorizada ou cancelada, e nunca a
 * de outro emissor (marcada ou com a conferência 'diferente').
 * @returns {{ ok: true } | { ok: false, code, message }}
 */
function podeServirNota(row) {
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'NFS-e não encontrada.' };
  if (temDpsNumeroJaUsado(row)) return { ok: false, code: 'NOTA_NAO_CONFERIDA', message: MSG_NOTA_DE_OUTRO_EMISSOR };
  if (!SERVIVEIS.has(row.status)) {
    return {
      ok: false, code: 'ESTADO_INVALIDO',
      message: `O PDF e o XML saem só de nota autorizada ou cancelada (situação atual: ${row.status}).`,
    };
  }
  if (row.xml_nfse && row.xml_dps && conferirNotaGravada(row).resultado === 'diferente') {
    return { ok: false, code: 'NOTA_NAO_CONFERIDA', message: MSG_NOTA_NAO_CONFERIDA };
  }
  return { ok: true };
}

module.exports = {
  idDaDpsEmbutida, conferirNotaGravada, podeServirNota,
  SERVIVEIS, MSG_NOTA_DE_OUTRO_EMISSOR, MSG_NOTA_NAO_CONFERIDA,
};
