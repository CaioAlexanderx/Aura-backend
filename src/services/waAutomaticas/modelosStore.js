// ============================================================
// AURA — WhatsApp: modelos editáveis (estado, edição, aprovação)
//
// Regra do Caio (26/11/2026): "texto novo só vale depois de aprovado pelo
// WhatsApp; até lá vai o anterior". Em vez de EDITAR o template aprovado
// na Meta (a Meta não diz se o texto antigo segue valendo durante a
// revisão), cada texto novo vira um template NOVO, de nome versionado
// (aura_<modelo>_v<N>). O antigo não é tocado. O que vale no envio é a
// maior versão APPROVED (ou PADRAO = a lojista voltou ao texto da Aura).
//
// LIMITE DE EDIÇÃO (Meta, "Template management"): template APROVADO só
// pode ser editado 1 vez em 24 h e 10 vezes em 30 dias; rejeitado ou
// pausado, sem limite. Como cada texto novo da lojista nasce de um
// modelo aprovado, aplicamos o mesmo limite, por modelo, contando as
// versões enviadas (PENDING ou APPROVED) — rejeitada não conta. Assim a
// regra da Meta vale mesmo que um dia o envio passe a editar no lugar.
// Fonte: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/template-management
// ============================================================
'use strict';

const db = require('../../config/database');
const modelosCatalogo = require('./modelos');

const LIMITE_24H = 1;
const LIMITE_30D = 10;
const HORAS_24 = 24 * 3600 * 1000;
const DIAS_30 = 30 * 24 * 3600 * 1000;

class ErroModelo extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

function schemaAusente(e) { return !!e && (e.code === '42P01' || e.code === '42703'); }

// ── Leitura ──────────────────────────────────────────────────
async function carregarVersoes(companyId, modelos = null) {
  try {
    const { rows } = await db.query(
      `-- wa:modelos-versoes
       SELECT id, modelo, versao, texto, template_name, estado, motivo, criado_em, decidido_em
         FROM wa_modelo_versoes
        WHERE company_id = $1 AND ($2::text[] IS NULL OR modelo = ANY($2::text[]))
        ORDER BY modelo, versao ASC`,
      [companyId, modelos]
    );
    return rows;
  } catch (e) {
    if (schemaAusente(e)) return [];
    throw e;
  }
}

async function carregarEstadosDosPadroes(companyId, nomes) {
  try {
    const { rows } = await db.query(
      `-- wa:modelos-padroes
       SELECT name, status FROM wa_templates
        WHERE company_id = $1 AND language = 'pt_BR' AND name = ANY($2::text[])`,
      [companyId, nomes]
    );
    return new Map(rows.map((r) => [r.name, String(r.status || '').toUpperCase()]));
  } catch (e) {
    if (schemaAusente(e)) return new Map();
    throw e;
  }
}

function limiteDeEdicao(versoes, agora = Date.now()) {
  const validas = versoes
    .filter((v) => v.estado === 'PENDING' || v.estado === 'APPROVED')
    .map((v) => new Date(v.criado_em).getTime())
    .sort((a, b) => a - b);
  const d24 = validas.filter((t) => agora - t < HORAS_24);
  const d30 = validas.filter((t) => agora - t < DIAS_30);
  let bloqueio = null;
  if (d24.length >= LIMITE_24H) {
    bloqueio = { code: 'EDICAO_LIMITE_24H', proxima_em: new Date(d24[0] + HORAS_24).toISOString() };
  } else if (d30.length >= LIMITE_30D) {
    bloqueio = { code: 'EDICAO_LIMITE_30D', proxima_em: new Date(d30[0] + DIAS_30).toISOString() };
  }
  return {
    pode: !bloqueio,
    proxima_em: bloqueio ? bloqueio.proxima_em : null,
    codigo: bloqueio ? bloqueio.code : null,
    restam_30_dias: Math.max(0, LIMITE_30D - d30.length),
  };
}

// Estado de UM modelo a partir das suas versões (já ordenadas ASC).
function montarEstado(modelo, versoes, estadoDoPadrao, agora = Date.now()) {
  const ativas = versoes.filter((v) => v.estado === 'APPROVED' || v.estado === 'PADRAO');
  const ativa = ativas.length ? ativas[ativas.length - 1] : null;
  const ultima = versoes.length ? versoes[versoes.length - 1] : null;
  const pendente = versoes.find((v) => v.estado === 'PENDING') || null;

  const usaPadrao = !ativa || ativa.estado === 'PADRAO';
  const textoEmUso = usaPadrao ? modelo.texto_padrao : ativa.texto;
  const templateEmUso = usaPadrao ? modelo.template_base : ativa.template_name;

  let estado = 'PRONTA';
  let motivo = null;
  if (pendente) estado = 'EM_APROVACAO';
  else if (ultima && ultima.estado === 'REJECTED') { estado = 'NAO_APROVADA'; motivo = ultima.motivo || null; }
  else if (usaPadrao && estadoDoPadrao !== 'APPROVED') estado = 'AGUARDANDO_PADRAO';

  return {
    key: modelo.key,
    automatica: modelo.automatica,
    titulo: modelo.titulo,
    categoria: modelo.categoria,
    campos: modelo.campos,
    texto_padrao: modelo.texto_padrao,
    texto_em_uso: textoEmUso,
    template_em_uso: templateEmUso,
    texto_novo: pendente ? pendente.texto : null,
    estado,
    motivo,
    edicao: limiteDeEdicao(versoes, agora),
  };
}

async function listar(companyId, automatica = null) {
  const alvo = modelosCatalogo.listar(automatica);
  const versoes = await carregarVersoes(companyId, alvo.map((x) => x.key));
  const padroes = await carregarEstadosDosPadroes(companyId, alvo.map((x) => x.template_base));
  return alvo.map((mod) => montarEstado(
    mod, versoes.filter((v) => v.modelo === mod.key), padroes.get(mod.template_base) || null
  ));
}

async function obter(companyId, key) {
  const mod = modelosCatalogo.obter(key);
  if (!mod) throw new ErroModelo(404, 'MODELO_DESCONHECIDO', 'Esse modelo de mensagem não existe.');
  const lista = await listar(companyId, mod.automatica);
  return lista.find((x) => x.key === key);
}

// O que o ENVIO usa: o texto e o template que valem agora. Texto novo
// pendente nunca entra aqui.
async function resolverParaEnvio(companyId, key) {
  const item = await obter(companyId, key);
  return {
    key, templateName: item.template_em_uso, language: 'pt_BR',
    texto: item.texto_em_uso, categoria: item.categoria,
    pronto: item.estado !== 'AGUARDANDO_PADRAO',
  };
}

// ── Meta ─────────────────────────────────────────────────────
async function credenciais(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:modelos-cred
       SELECT wa_waba_id, wa_access_token FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0];
    if (!r || !r.wa_waba_id || !r.wa_access_token) return null;
    return { wabaId: r.wa_waba_id, token: require('../waOutbox').decryptToken(r.wa_access_token) };
  } catch (e) {
    if (schemaAusente(e)) return null;
    throw e;
  }
}

function montarTemplateMeta({ name, categoria, texto }) {
  const { corpo, exemplos } = modelosCatalogo.paraCorpoMeta(texto);
  const body = { type: 'BODY', text: corpo };
  if (exemplos.length) body.example = { body_text: [exemplos] };
  return {
    name, language: 'pt_BR', category: categoria,
    components: [body, { type: 'FOOTER', text: modelosCatalogo.RODAPE }],
  };
}

async function criarNaMeta(companyId, { name, categoria, texto }) {
  const cred = await credenciais(companyId);
  if (!cred) throw new ErroModelo(409, 'NAO_CONECTADO', 'Conecte o WhatsApp da loja antes de mandar texto para aprovação.');
  const wa = require('../whatsapp');
  try {
    return await wa.createTemplate(cred.wabaId, cred.token, montarTemplateMeta({ name, categoria, texto }));
  } catch (e) {
    throw new ErroModelo(502, 'META_RECUSOU',
      'O WhatsApp não aceitou o pedido agora. Tente de novo em alguns minutos.', { detalhe: String(e.message || '').slice(0, 200) });
  }
}

async function registrarTemplateLocal(companyId, { name, categoria, texto, criado }) {
  const waOutbox = require('../waOutbox');
  await waOutbox.applyTemplateStatus(companyId, {
    name, language: 'pt_BR',
    status: (criado && criado.status) || 'PENDING',
    metaTemplateId: criado && criado.id != null ? String(criado.id) : null,
  });
  await db.query(
    `-- wa:modelos-preview
     UPDATE wa_templates SET body_preview = $1, category = $2, updated_at = NOW()
      WHERE company_id = $3 AND name = $4 AND language = 'pt_BR'`,
    [modelosCatalogo.paraCorpoMeta(texto).corpo, categoria, companyId, name]
  ).catch(() => {});
}

// ── Escrita ──────────────────────────────────────────────────
// Texto novo da lojista -> validação -> limite -> template novo na Meta.
async function enviarTextoNovo(companyId, key, texto, { agora = Date.now() } = {}) {
  const mod = modelosCatalogo.obter(key);
  if (!mod) throw new ErroModelo(404, 'MODELO_DESCONHECIDO', 'Esse modelo de mensagem não existe.');

  const v = modelosCatalogo.validar(mod, texto);
  if (!v.ok) {
    throw new ErroModelo(422, 'TEXTO_INVALIDO',
      (v.checks.find((c) => !c.ok) || {}).texto || 'O texto não passou nas regras do WhatsApp.', { checks: v.checks });
  }

  const versoes = await carregarVersoes(companyId, [key]);
  if (versoes.some((x) => x.estado === 'PENDING')) {
    throw new ErroModelo(409, 'EM_APROVACAO',
      'Já existe um texto desse modelo esperando a aprovação do WhatsApp. Espere a resposta para mandar outro.');
  }
  const lim = limiteDeEdicao(versoes, agora);
  if (!lim.pode) {
    const quando = new Date(lim.proxima_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    throw new ErroModelo(429, lim.codigo,
      lim.codigo === 'EDICAO_LIMITE_24H'
        ? `O WhatsApp só deixa mudar o texto de uma mensagem uma vez por dia. Você poderá mudar de novo em ${quando}.`
        : `O WhatsApp só deixa mudar o texto de uma mensagem 10 vezes por mês. Você poderá mudar de novo em ${quando}.`,
      { proxima_em: lim.proxima_em });
  }

  const versao = versoes.reduce((mx, x) => Math.max(mx, x.versao), 0) + 1;
  const name = `${mod.template_base}_v${versao}`;
  const criado = await criarNaMeta(companyId, { name, categoria: mod.categoria, texto });
  await registrarTemplateLocal(companyId, { name, categoria: mod.categoria, texto, criado });
  await db.query(
    `-- wa:modelos-nova-versao
     INSERT INTO wa_modelo_versoes (company_id, modelo, versao, texto, template_name, estado)
     VALUES ($1,$2,$3,$4,$5,'PENDING')`,
    [companyId, key, versao, texto, name]
  );
  return { versao, modelo: await obter(companyId, key) };
}

// "Voltar ao texto da Aura": linha PADRAO vence as anteriores; pendente
// e recusada deixam de existir para a lojista.
async function restaurarPadrao(companyId, key) {
  const mod = modelosCatalogo.obter(key);
  if (!mod) throw new ErroModelo(404, 'MODELO_DESCONHECIDO', 'Esse modelo de mensagem não existe.');
  const versoes = await carregarVersoes(companyId, [key]);
  const versao = versoes.reduce((mx, x) => Math.max(mx, x.versao), 0) + 1;
  // Um texto pendente que ficar para trás ainda pode ser aprovado depois
  // pela Meta: marcamos como superado para o webhook não promovê-lo.
  await db.query(
    `-- wa:modelos-restaurar-supera
     UPDATE wa_modelo_versoes SET estado = 'REJECTED', motivo = 'Substituído pelo texto da Aura.', decidido_em = NOW()
      WHERE company_id = $1 AND modelo = $2 AND estado = 'PENDING'`,
    [companyId, key]
  );
  await db.query(
    `-- wa:modelos-restaurar
     INSERT INTO wa_modelo_versoes (company_id, modelo, versao, texto, template_name, estado, decidido_em)
     VALUES ($1,$2,$3,NULL,$4,'PADRAO',NOW())`,
    [companyId, key, versao, mod.template_base]
  );
  return obter(companyId, key);
}

// Cria na Meta os 15 templates padrão que ainda não existem. Idempotente.
async function prepararPadroes(companyId) {
  const todos = modelosCatalogo.listar();
  const existentes = await carregarEstadosDosPadroes(companyId, todos.map((x) => x.template_base));
  let criados = 0; let jaExistiam = 0;
  for (const mod of todos) {
    if (existentes.has(mod.template_base)) { jaExistiam++; continue; }
    const criado = await criarNaMeta(companyId, { name: mod.template_base, categoria: mod.categoria, texto: mod.texto_padrao });
    await registrarTemplateLocal(companyId, { name: mod.template_base, categoria: mod.categoria, texto: mod.texto_padrao, criado });
    criados++;
  }
  return { criados, ja_existiam: jaExistiam };
}

// ── Aprovação (webhook / sync) ───────────────────────────────
const MOTIVOS = {
  TAG_CONTENT_MISMATCH: 'o texto parece propaganda',
  INVALID_FORMAT: 'o formato do texto não foi aceito (campo roxo no começo ou no fim do texto)',
  ABUSIVE_CONTENT: 'o texto foi considerado ofensivo',
  SCAM: 'o texto foi considerado suspeito',
};
function frasePorMotivo(reason) {
  const k = String(reason || '').toUpperCase();
  return MOTIVOS[k] || 'o texto não passou na revisão';
}

// Chamado por waOutbox.applyTemplateStatus a cada mudança de status.
// Só faz algo para versões de texto da lojista (nome aura_<modelo>_v<N>).
async function onTemplateStatus(companyId, { name, status, reason = null }, { notificar = true } = {}) {
  const st = String(status || '').toUpperCase();
  if (!name || (st !== 'APPROVED' && st !== 'REJECTED')) return null;
  let linha = null;
  try {
    const { rows } = await db.query(
      `-- wa:modelos-decisao
       UPDATE wa_modelo_versoes
          SET estado = $3, motivo = $4, decidido_em = NOW()
        WHERE company_id = $1 AND template_name = $2 AND estado = 'PENDING'
        RETURNING id, modelo, versao`,
      [companyId, name, st, st === 'REJECTED' ? frasePorMotivo(reason) : null]
    );
    linha = rows[0] || null;
  } catch (e) {
    if (schemaAusente(e)) return null;
    throw e;
  }
  if (!linha) return null;
  if (notificar) await avisarNoSino(companyId, linha, st, reason);
  return { ...linha, estado: st };
}

async function avisarNoSino(companyId, linha, st, reason) {
  const mod = modelosCatalogo.obter(linha.modelo);
  const titulo = mod ? mod.titulo : 'mensagem';
  const lojaEvents = require('../lojaEvents');
  if (st === 'APPROVED') {
    return lojaEvents.emitLojaEvent('loja_wa_modelo_aprovado', { company_id: companyId, modelo_titulo: titulo },
      { dedupeSuffix: linha.id });
  }
  return lojaEvents.emitLojaEvent('loja_wa_modelo_reprovado', { company_id: companyId, modelo_titulo: titulo, motivo: frasePorMotivo(reason) },
    { dedupeSuffix: linha.id });
}

module.exports = {
  ErroModelo, LIMITE_24H, LIMITE_30D,
  carregarVersoes, limiteDeEdicao, montarEstado, listar, obter, resolverParaEnvio,
  montarTemplateMeta, enviarTextoNovo, restaurarPadrao, prepararPadroes,
  onTemplateStatus, frasePorMotivo,
};
