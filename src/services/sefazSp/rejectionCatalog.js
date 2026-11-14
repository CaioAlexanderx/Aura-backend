// ============================================================
// AURA. — sefazSp/rejectionCatalog: cStat → mensagem amigável pro lojista
// Roadmap NFC-e própria v1 — S2.2.
//
// Semente = rejeições REAIS já registradas em nfce_emissions (minerado
// 10/06/2026): 778 (12×), 391 (3×), 442 (1×) + clássicas de NFC-e.
// Vale pros DOIS caminhos (gateway e emissão própria) — a chave é o cStat.
//
// Cada entrada: titulo (o que houve, sem juridiquês), acao (o que o
// lojista faz AGORA), quem ('lojista' resolve sozinho | 'config' é
// cadastro/configuração | 'aura' é bug nosso | 'sefaz' é instabilidade).
// ============================================================
'use strict';

const CATALOG = {
  // ── minerados da base (Davi Calçados) ──
  '778': {
    titulo: 'NCM do produto não existe na tabela do governo',
    acao: 'Abra o cadastro do produto citado e corrija o campo NCM (8 dígitos). Na dúvida, confirme o NCM com seu contador e emita de novo.',
    quem: 'config',
  },
  '391': {
    titulo: 'Venda no cartão sem os dados do cartão na nota',
    acao: 'Tente emitir novamente. Se repetir, registre a venda com a forma de pagamento correta (crédito/débito) em vez de "outros".',
    quem: 'aura',
  },
  '442': {
    titulo: 'Descrição da forma de pagamento não permitida',
    acao: 'Tente emitir novamente. Se repetir, avise o suporte Aura — é ajuste interno na forma de pagamento.',
    quem: 'aura',
  },
  // ── clássicas de NFC-e ──
  '204': {
    titulo: 'Nota duplicada: esse número já foi usado',
    acao: 'A venda provavelmente já tem nota autorizada. Confira na lista de notas antes de emitir de novo.',
    quem: 'aura',
  },
  '539': {
    titulo: 'Nota duplicada com diferença na chave',
    acao: 'Houve uma tentativa anterior com o mesmo número. Confira na lista se a nota já saiu; se não, tente emitir novamente.',
    quem: 'aura',
  },
  '215': {
    titulo: 'Nota com erro técnico de formato (schema)',
    acao: 'Avise o suporte Aura com o número da venda — é correção do nosso lado, não mexa no cadastro.',
    quem: 'aura',
  },
  '225': {
    titulo: 'Nota com erro técnico de formato (schema)',
    acao: 'Avise o suporte Aura com o número da venda — é correção do nosso lado.',
    quem: 'aura',
  },
  '217': {
    titulo: 'Nota ainda não consta na SEFAZ',
    acao: 'Aguarde alguns instantes e use "Atualizar" na nota. Se persistir, reemita a venda — o número será reaproveitado.',
    quem: 'sefaz',
  },
  '280': {
    titulo: 'Certificado digital com problema',
    acao: 'O certificado A1 da empresa está inválido ou vencido. Renove/reenvie o certificado em Configurações > Nota Fiscal.',
    quem: 'config',
  },
  '301': {
    titulo: 'Empresa com emissão bloqueada (irregularidade do emitente)',
    acao: 'Há pendência da empresa na SEFAZ. Fale com seu contador — não é problema do sistema.',
    quem: 'config',
  },
  '302': {
    titulo: 'Destinatário com pendência na SEFAZ',
    acao: 'O CPF/CNPJ informado na nota tem irregularidade. Confirme o documento com o cliente ou emita sem identificar o consumidor.',
    quem: 'lojista',
  },
  '501': {
    titulo: 'Prazo de cancelamento expirado',
    acao: 'A SEFAZ não aceita mais cancelar esta nota. Fale com seu contador sobre a regularização (ex.: nota de devolução).',
    quem: 'lojista',
  },
  '573': {
    titulo: 'Esta nota já foi cancelada',
    acao: 'Nada a fazer — o cancelamento anterior já valeu.',
    quem: 'lojista',
  },
  '613': {
    titulo: 'Chave de acesso com dígito inválido',
    acao: 'Avise o suporte Aura — é correção do nosso lado.',
    quem: 'aura',
  },
  '703': {
    titulo: 'Data de emissão muito atrasada',
    acao: 'A nota foi gerada com data antiga demais. Emita novamente agora.',
    quem: 'lojista',
  },
  '704': {
    titulo: 'Data de emissão no futuro',
    acao: 'O relógio do computador/caixa parece errado. Acerte a data/hora e emita de novo.',
    quem: 'lojista',
  },
  '770': {
    titulo: 'Produto com código de barras (GTIN/EAN) inválido',
    acao: 'Corrija o código de barras no cadastro do produto citado (ou deixe em branco) e emita de novo.',
    quem: 'config',
  },
  '786': {
    titulo: 'CPF do consumidor inválido',
    acao: 'Confira o CPF digitado com o cliente, ou emita sem CPF na nota.',
    quem: 'lojista',
  },
  '865': {
    titulo: 'Total da nota não bate com a soma dos itens',
    acao: 'Tente emitir novamente. Se repetir, avise o suporte Aura com o número da venda.',
    quem: 'aura',
  },
  // ── NF-e 55 de venda (14/11/2026): destinatário completo ──
  '208': {
    titulo: 'CNPJ do cliente inválido',
    acao: 'Confira o CNPJ do cliente na nota (no cadastro do cliente ou no passo do destinatário) e emita de novo.',
    quem: 'lojista',
  },
  '237': {
    titulo: 'CPF do cliente inválido',
    acao: 'Confira o CPF do cliente na nota e emita de novo.',
    quem: 'lojista',
  },
  '210': {
    titulo: 'Inscrição estadual (IE) do cliente inválida',
    acao: 'Confira a IE com o cliente. Se ele não tiver IE, marque como "não contribuinte" ou "isento" e emita de novo.',
    quem: 'lojista',
  },
  '232': {
    titulo: 'Faltou a inscrição estadual (IE) do cliente',
    acao: 'O cliente foi marcado como contribuinte, mas a nota saiu sem a IE. Informe a IE (ou marque "não contribuinte") e emita de novo.',
    quem: 'lojista',
  },
  '233': {
    titulo: 'A inscrição estadual (IE) do cliente não está cadastrada na SEFAZ',
    acao: 'Confira a IE com o cliente. Se ela estiver baixada ou errada, peça a IE certa ou marque o cliente como não contribuinte.',
    quem: 'lojista',
  },
  '234': {
    titulo: 'A inscrição estadual (IE) não é deste CNPJ',
    acao: 'A IE informada pertence a outra empresa. Confira o CNPJ e a IE do cliente e emita de novo.',
    quem: 'lojista',
  },
  '274': {
    titulo: 'Cidade do cliente com código inválido',
    acao: 'Confira o CEP e a cidade do endereço do cliente e emita de novo.',
    quem: 'lojista',
  },
  '275': {
    titulo: 'A cidade do cliente não é do estado informado',
    acao: 'O CEP ou a cidade não batem com o estado (UF) do endereço do cliente. Confira o CEP e o estado e emita de novo.',
    quem: 'lojista',
  },
  '521': {
    titulo: 'CFOP de venda dentro do estado para cliente de outro estado',
    acao: 'Confira o estado (UF) do endereço do cliente e emita de novo. Se repetir, avise o suporte Aura.',
    quem: 'aura',
  },
  '522': {
    titulo: 'CFOP de venda dentro do estado para cliente de outro estado',
    acao: 'Confira o estado (UF) do endereço do cliente e emita de novo. Se repetir, avise o suporte Aura.',
    quem: 'aura',
  },
  '523': {
    titulo: 'CFOP de venda para outro estado com cliente do mesmo estado',
    acao: 'Confira o estado (UF) do endereço do cliente e emita de novo. Se repetir, avise o suporte Aura.',
    quem: 'aura',
  },
  '772': {
    titulo: 'Venda marcada como para outro estado, mas o cliente é do mesmo estado',
    acao: 'Confira o estado (UF) do endereço do cliente e emita de novo.',
    quem: 'lojista',
  },
  '773': {
    titulo: 'Venda marcada como dentro do estado, mas o cliente é de outro estado',
    acao: 'Confira o estado (UF) do endereço do cliente e emita de novo.',
    quem: 'lojista',
  },
  '694': {
    titulo: 'Venda para consumidor de outro estado sem o cálculo do DIFAL',
    acao: 'A Aura ainda não emite NF-e com DIFAL. Para este cliente, emita NFC-e no balcão ou fale com o seu contador.',
    quem: 'aura',
  },
  '696': {
    titulo: 'Cliente sem inscrição estadual tem que ser consumidor final',
    acao: 'Marque a venda como para consumidor final (ou informe a IE do cliente) e emita de novo.',
    quem: 'lojista',
  },
  '206': {
    titulo: 'Este número de NF-e já foi inutilizado',
    acao: 'Tente emitir novamente. Se repetir, avise o suporte Aura.',
    quem: 'aura',
  },
  // ── eventos da NF-e 55 (14/11/2026, CP5): cancelamento e carta de correção ──
  '594': {
    titulo: 'Esta nota já chegou ao limite de cartas de correção',
    acao: 'A SEFAZ aceita até 20 cartas por nota. Fale com seu contador sobre como regularizar.',
    quem: 'lojista',
  },
  '218': {
    titulo: 'Esta nota já está cancelada na SEFAZ',
    acao: 'Nada a fazer: o cancelamento já valeu. Atualize a lista de notas.',
    quem: 'lojista',
  },
  '598': {
    titulo: 'Nome do cliente fora do padrão da homologação',
    acao: 'Avise o suporte Aura — em homologação o nome do cliente é fixo, é correção do nosso lado.',
    quem: 'aura',
  },
  '999': {
    titulo: 'Erro inesperado na SEFAZ',
    acao: 'Aguarde 1 minuto e tente de novo. Se persistir, a SEFAZ pode estar instável — a emissão entra em contingência automaticamente.',
    quem: 'sefaz',
  },
};

/**
 * Resolve a mensagem amigável de um cStat.
 * @param {string|number} cStat
 * @param {string} [xMotivo] — motivo cru da SEFAZ (fallback)
 * @returns {{ cStat, titulo, acao, quem, conhecida }}
 */
function lookup(cStat, xMotivo) {
  const code = String(cStat || '').trim();
  const hit = CATALOG[code];
  if (hit) return { cStat: code, conhecida: true, ...hit };
  return {
    cStat: code || null,
    conhecida: false,
    titulo: xMotivo
      ? `Nota rejeitada pela SEFAZ: ${String(xMotivo).replace(/^Rejei[cç][aã]o:\s*/i, '')}`
      : 'Nota rejeitada pela SEFAZ',
    acao: 'Tente emitir novamente. Se repetir, avise o suporte Aura informando o código ' + (code || 'da rejeição') + '.',
    quem: 'aura',
  };
}

/** Extrai cStat de um error_message no formato "[778] Rejeição: ..." */
function cStatFromErrorMessage(errorMessage) {
  const m = String(errorMessage || '').match(/^\[(\d{3})\]/);
  return m ? m[1] : null;
}

module.exports = { lookup, cStatFromErrorMessage, CATALOG };
