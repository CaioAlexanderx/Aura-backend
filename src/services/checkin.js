// ============================================================
// AURA. — Check-in do prospect: regras (14/10/2026)
//
// Três perguntas em chip, depois da escolha da frente e antes do Painel
// (comeco, onde_anota, produtos_faixa). Gravadas em companies.checkin
// (migration 384), um jsonb só — o mesmo que a seção "Check-in" do Registrar
// contato da Gestão Aura completa com como_chegou, fiado e quem_decide.
//
// Funções puras: nada aqui fala com o banco. A rota é routes/checkin.js e a
// leitura para a rodada da Cassie é services/painelBlocos/checkin.js.
//
// PARÂMETROS (variáveis de ambiente, lidas a cada chamada — mudar não pede
// deploy de código, só o restart que a Railway já faz ao salvar a variável):
//   CHECKIN_ENABLED               interruptor da tela. Padrão: ligado.
//                                 'false', '0', 'off' ou 'no' desligam.
//   CHECKIN_DESDE                 'YYYY-MM-DD' (Brasília). Só cadastros criados
//                                 a partir deste dia veem a tela. Padrão: a
//                                 data de subida (DESDE_PADRAO abaixo).
//   CHECKIN_LIMIAR_PRODUTO_24H    fração (0..1) de cadastros com produto em
//                                 24 h abaixo da qual a tela deve ser
//                                 desligada. Padrão 0.57 (linha de base da
//                                 Nina); a Cassie propôs 0.40. Decisão do
//                                 Caio: por isso é parâmetro, não constante.
// ============================================================
'use strict';

const VERSAO = 1;

// Data de subida da tela (parte 1 em produção até 16/10, janela das 20h).
// Só vale quando CHECKIN_DESDE não está definida.
const DESDE_PADRAO = '2026-10-16';
const LIMIAR_PADRAO = 0.57;
// A regra de parada olha os primeiros N cadastros com a tela.
const AMOSTRA_MINIMA = 15;

// As três perguntas da tela do cliente, na ordem em que aparecem.
const CHAVES_RESPOSTA = ['comeco', 'onde_anota', 'produtos_faixa'];
// O que a equipe preenche pelo Registrar contato (routes/adminPainel.js).
const CHAVES_EQUIPE = ['como_chegou', 'fiado', 'quem_decide'];
const MAX_VALOR = 40;

const DESLIGADO = new Set(['false', '0', 'off', 'no', 'nao', 'não']);

function ligado(env = process.env) {
  const v = env.CHECKIN_ENABLED;
  if (v === undefined || v === null || String(v).trim() === '') return true;
  return !DESLIGADO.has(String(v).trim().toLowerCase());
}

function diaValido(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const d = s.trim();
  const t = new Date(`${d}T00:00:00.000Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d ? null : d;
}

function limiarProduto24h(env = process.env) {
  const bruto = env.CHECKIN_LIMIAR_PRODUTO_24H;
  if (bruto === undefined || bruto === null || String(bruto).trim() === '') return LIMIAR_PADRAO;
  const n = Number(String(bruto).trim().replace(',', '.'));
  // 57 também vale (porcentagem): vira 0.57.
  const f = n > 1 && n <= 100 ? n / 100 : n;
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : LIMIAR_PADRAO;
}

function configuracao(env = process.env) {
  return {
    ligado: ligado(env),
    desde: diaValido(env.CHECKIN_DESDE || '') || DESDE_PADRAO,
    limiar: limiarProduto24h(env),
    amostra: AMOSTRA_MINIMA,
  };
}

// Início do dia (Brasília = UTC-3, sem horário de verão) como Date.
const inicioDoDia = (ymd) => new Date(`${ymd}T03:00:00.000Z`);

const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Estado que a tela do cliente lê. `empresa` = { created_at, checkin, eh_dojo }.
// `staff` = o token é de staff (modo admin): a tela nunca aparece para ele.
function estado({ empresa, config = configuracao(), staff = false }) {
  const j = objeto(empresa && empresa.checkin);
  const pulou = j.pulou === true;
  const terminou = !!j.respondido_em;
  const respondido = terminou && !pulou;

  const criado = empresa && empresa.created_at ? new Date(empresa.created_at) : null;
  const novo = !!criado && !Number.isNaN(criado.getTime()) && criado >= inicioDoDia(config.desde);
  const habilitado = config.ligado && !staff && !(empresa && empresa.eh_dojo) && novo && !terminou && !pulou;

  const temResposta = CHAVES_RESPOSTA.some((k) => typeof j[k] === 'string' && j[k] !== '');
  const respostas = temResposta
    ? Object.fromEntries(CHAVES_RESPOSTA.map((k) => [k, typeof j[k] === 'string' && j[k] !== '' ? j[k] : null]))
    : null;

  return { habilitado, respondido, pulou, versao: VERSAO, respostas };
}

// Valida o corpo do PUT. Devolve { erro } ou { patch } com só as chaves que
// vieram. Texto curto, sem enum: as opções dos chips são da tela.
function normalizarPut(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { erro: 'Corpo inválido: envie um objeto com comeco, onde_anota, produtos_faixa e/ou pulou.' };
  }
  const permitidas = [...CHAVES_RESPOSTA, 'pulou'];
  const extras = Object.keys(body).filter((k) => !permitidas.includes(k));
  if (extras.length) return { erro: `Chave não aceita: ${extras.join(', ')}.` };

  const patch = {};
  for (const k of CHAVES_RESPOSTA) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string') return { erro: `${k} deve ser texto.` };
    const v = body[k].trim();
    if (!v) return { erro: `${k} não pode ser vazio.` };
    if (v.length > MAX_VALOR) return { erro: `${k} aceita até ${MAX_VALOR} caracteres.` };
    patch[k] = v;
  }
  if (body.pulou !== undefined) {
    if (typeof body.pulou !== 'boolean') return { erro: 'pulou deve ser true ou false.' };
    patch.pulou = body.pulou;
  }
  if (!Object.keys(patch).length) return { erro: 'Envie ao menos uma resposta ou pulou.' };
  return { patch };
}

// Aplica o patch ao json atual. O carimbo é do servidor: respondido_em vale a
// PRIMEIRA vez que a pessoa responde ou pula (volta a tela ao Painel e ela
// não reaparece); versao acompanha. Devolve { checkin, eventos } — eventos são
// os registros de audit_log que esta gravação gera (cada um uma vez só).
function aplicar(atual, patch, agora = new Date()) {
  const antes = objeto(atual);
  const depois = { ...antes };
  const iso = agora.toISOString();

  for (const k of CHAVES_RESPOSTA) if (patch[k] !== undefined) depois[k] = patch[k];
  const respondeu = CHAVES_RESPOSTA.some((k) => patch[k] !== undefined);

  if (patch.pulou === true) depois.pulou = true;
  else if (patch.pulou === false || respondeu) depois.pulou = false;

  depois.versao = VERSAO;
  if (!depois.respondido_em) depois.respondido_em = iso;

  const eventos = [];
  const jaRespondeu = !!antes.respondido_em && antes.pulou !== true;
  const jaPulou = antes.pulou === true;
  if (respondeu && !jaRespondeu) eventos.push('checkin.respondido');
  if (depois.pulou === true && !jaPulou) eventos.push('checkin.pulou');

  return { checkin: depois, eventos };
}

module.exports = {
  VERSAO, DESDE_PADRAO, LIMIAR_PADRAO, AMOSTRA_MINIMA, CHAVES_RESPOSTA, CHAVES_EQUIPE, MAX_VALOR,
  configuracao, ligado, limiarProduto24h, inicioDoDia, estado, normalizarPut, aplicar,
};
