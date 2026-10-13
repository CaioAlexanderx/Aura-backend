// ============================================================
// AURA. — resumoDaMadrugada.js
// O que chegou no WhatsApp da Aura entre 21h e 8h, entregue às 8h.
//
// montarResumo()     texto + itens do que chegou na noite que termina em `hoje`
// gerarEEnviar()     grava o resumo em hub_agent_events (tipo 'resumo_madrugada')
//                    e manda por e-mail para contato@getaura.com.br
//
// Idempotente por dia: a linha do evento é a trava (índice único por
// empresa+dia, migration 376). Quem consegue inserir a linha envia; quem não
// consegue (outra instância, ou o job de novo depois de um deploy) desiste.
// Se o envio falha, a linha é removida e o próximo tick tenta de novo.
//
// Sem nenhum contato na noite o evento é gravado (o dia fica fechado) e NÃO
// se manda e-mail: um "nada chegou" diário viraria ruído — e antes de o
// número estar ligado seria toda manhã.
// ============================================================
'use strict';

const db = require('../config/database');
const cw = require('./contatosWhatsapp');

const DESTINO_PADRAO = 'contato@getaura.com.br';
const TIPO_EVENTO = 'resumo_madrugada';

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703' || e.code === '23514'); }

// 'YYYY-MM-DD' → 'DD/MM'
const dm = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const hhmm = (d) => new Date(d.getTime() - 3 * 3600000).toISOString().slice(11, 16);

// Janela da noite que termina às 8h de `hoje`: 21h do dia anterior até 8h
// (BRT = UTC-3, então 00:00Z e 11:00Z do próprio dia).
function janelaDaNoite(hoje) {
  return {
    desde: new Date(`${hoje}T00:00:00.000Z`),
    ate: new Date(`${hoje}T11:00:00.000Z`),
  };
}

function descreverItem(c) {
  const quem = c.nome || (c.empresa && c.empresa.nome) || cw.formatarTelefone(c.telefone);
  const quemTexto = c.nome || (c.empresa && c.empresa.nome) ? `${quem} (${cw.formatarTelefone(c.telefone)})` : quem;
  const partes = [];
  if (c.resposta_aurinha_em) {
    partes.push(c.texto_aurinha ? `Aurinha: "${cw.umaLinha(c.texto_aurinha)}"` : 'Aurinha respondeu');
  }
  if (c.situacao === 'humano') partes.push('Caio já respondeu');
  const resposta = partes.length ? partes.join(' · ') : 'Sem resposta';
  return {
    conversa_id: c.conversa_id,
    quando: c.chegou_em.toISOString(),
    hora: hhmm(c.chegou_em),
    quem: quemTexto,
    telefone: c.telefone,
    empresa: c.empresa ? c.empresa.nome : null,
    disse: cw.umaLinha(c.primeira_mensagem) || '(sem texto)',
    mensagens: c.mensagens_do_cliente,
    situacao: c.situacao,
    resposta,
    link: cw.linkWhatsapp(c.telefone),
  };
}

function montarTexto({ hoje, itens }) {
  const aurinha = itens.filter((i) => i.situacao === 'aurinha').length;
  const caio = itens.filter((i) => i.situacao === 'humano').length;
  const sem = itens.filter((i) => i.situacao === 'sem_resposta').length;
  const ontem = dm(new Date(Date.parse(`${hoje}T12:00:00Z`) - 86400000).toISOString().slice(0, 10));

  const linhas = [
    `Madrugada no WhatsApp da Aura — ${dm(hoje)} (das 21h de ${ontem} às 8h)`,
    '',
    `${itens.length} ${itens.length === 1 ? 'contato' : 'contatos'}: ${aurinha} respondido${aurinha === 1 ? '' : 's'} pela Aurinha, ${caio} pelo Caio, ${sem} sem resposta.`,
  ];
  itens.forEach((i, n) => {
    linhas.push('', `${n + 1}. ${i.hora} — ${i.quem}${i.empresa && !i.quem.startsWith(i.empresa) ? ` · ${i.empresa}` : ''}`);
    linhas.push(`   Disse: "${i.disse}"${i.mensagens > 1 ? ` (+${i.mensagens - 1} ${i.mensagens - 1 === 1 ? 'mensagem' : 'mensagens'})` : ''}`);
    linhas.push(`   ${i.resposta}`);
    if (i.link) linhas.push(`   ${i.link}`);
  });
  return linhas.join('\n');
}

function montarHtml({ dia: hoje, itens, texto }, { emailLayout, escapeHtml }) {
  const cartoes = itens.map((i) => `
    <div style="margin:0 0 14px;padding:12px 14px;background:#161827;border-radius:12px;">
      <p style="margin:0;color:#e2e8f0;font-size:14px;font-weight:700;">${escapeHtml(i.hora)} — ${escapeHtml(i.quem)}${i.empresa ? ` <span style="color:#a78bfa;font-weight:400;">· ${escapeHtml(i.empresa)}</span>` : ''}</p>
      <p style="margin:6px 0 0;color:#cbd5e1;font-size:13px;line-height:1.5;">&ldquo;${escapeHtml(i.disse)}&rdquo;</p>
      <p style="margin:6px 0 0;color:#8a8aa0;font-size:12px;">${escapeHtml(i.resposta)}${i.link ? ` &middot; <a href="${escapeHtml(i.link)}" style="color:#a78bfa;">abrir no WhatsApp</a>` : ''}</p>
    </div>`).join('');
  const primeira = texto.split('\n').slice(2, 3)[0] || '';
  return emailLayout(`
    <h2 style="color:#a78bfa;margin:0 0 6px;font-size:20px;">Madrugada no WhatsApp &mdash; ${escapeHtml(dm(hoje))}</h2>
    <p style="color:#8a8aa0;font-size:13px;margin:0 0 18px;line-height:1.5;">${escapeHtml(primeira)}</p>
    ${cartoes}`);
}

// Monta o resumo da noite que termina em `hoje` (dia BRT). Só lê.
async function montarResumo({ hoje, db: banco = db, empresas = true } = {}) {
  const { desde, ate } = janelaDaNoite(hoje);
  const { ativo, contatos } = await cw.carregarContatos({ db: banco, desde, ate, empresas });
  const itens = contatos
    .slice()
    .sort((x, y) => x.chegou_em - y.chegou_em)
    .map(descreverItem);
  return {
    ativo, dia: hoje, total: itens.length, itens,
    texto: itens.length ? montarTexto({ hoje, itens }) : `Nenhum contato entre 21h e 8h (${dm(hoje)}).`,
  };
}

async function jaGerado(banco, companyId, hoje) {
  const { rows } = await banco.query(
    `-- resumo:existe
     SELECT id, detail FROM hub_agent_events
      WHERE company_id = $1 AND type = '${TIPO_EVENTO}' AND detail->>'dia' = $2
      LIMIT 1`,
    [companyId, hoje]
  );
  return rows[0] || null;
}

// Gera o resumo do dia e entrega. Devolve { ok, motivo?, total, enviado }.
//   JA_GERADO         o dia já tem resumo (idempotência)
//   DORMENTE          sem AURA_COMPANY_ID
//   MIGRATION_PENDENTE a 376 ainda não subiu (sem a trava, não envia)
//   ENVIO_FALHOU      o e-mail não saiu; a linha foi removida para nova tentativa
async function gerarEEnviar({ hoje, db: banco = db, mailer = null, para = null } = {}) {
  const companyId = cw.auraCompanyId();
  if (!companyId) return { ok: false, motivo: 'DORMENTE', total: 0, enviado: false };

  try {
    if (await jaGerado(banco, companyId, hoje)) return { ok: true, motivo: 'JA_GERADO', total: 0, enviado: false };

    const resumo = await montarResumo({ hoje, db: banco });
    const destino = para || process.env.RESUMO_MADRUGADA_EMAIL || DESTINO_PADRAO;
    const detail = {
      dia: hoje, total: resumo.total, itens: resumo.itens, texto: resumo.texto,
      entrega: { canal: 'email', para: destino, enviado: false, ...(resumo.total ? {} : { motivo: 'SEM_CONTATOS' }) },
    };

    // A trava: só uma instância, só um envio por dia.
    const { rows } = await banco.query(
      `-- resumo:trava
       INSERT INTO hub_agent_events (company_id, type, detail)
       VALUES ($1, '${TIPO_EVENTO}', $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [companyId, JSON.stringify(detail)]
    );
    if (!rows.length) return { ok: true, motivo: 'JA_GERADO', total: resumo.total, enviado: false };
    const eventoId = rows[0].id;

    if (!resumo.total) return { ok: true, total: 0, enviado: false };

    const m = { ...require('./mailer'), ...(mailer || {}) };
    try {
      await m.sendMail({
        to: destino,
        subject: `Madrugada no WhatsApp da Aura: ${resumo.total} ${resumo.total === 1 ? 'contato' : 'contatos'} (${dm(hoje)})`,
        text: resumo.texto,
        html: montarHtml(resumo, m),
      });
    } catch (err) {
      await banco.query('DELETE FROM hub_agent_events WHERE id = $1', [eventoId]).catch(() => {});
      return { ok: false, motivo: 'ENVIO_FALHOU', erro: String(err && err.message || err).slice(0, 300), total: resumo.total, enviado: false };
    }

    await banco.query(
      `UPDATE hub_agent_events
          SET detail = jsonb_set(detail, '{entrega,enviado}', 'true'::jsonb)
        WHERE id = $1`,
      [eventoId]
    ).catch(() => {});
    return { ok: true, total: resumo.total, enviado: true, para: destino };
  } catch (e) {
    // 23514 = CHECK de tipo ainda sem 'resumo_madrugada' (migration 376).
    if (isMissingSchema(e)) return { ok: false, motivo: 'MIGRATION_PENDENTE', total: 0, enviado: false };
    throw e;
  }
}

module.exports = { montarResumo, gerarEEnviar, janelaDaNoite, montarTexto, TIPO_EVENTO, DESTINO_PADRAO };
