// ============================================================
// AURA. — Relatório semanal de quem tem várias lojas: HTML (26/10/2026)
//
// Desenho aprovado: mockup "Relatório da semana para quem tem várias lojas"
// (v3, Nina + Caio). Um renderizador para os dois lugares, como o de uma
// loja (relatorioSemanalBlocos):
//   modo 'email'   e-mail; o desenho vale para até 3 lojas. Acima disso, só
//                  a segurança: as 3 maiores e "outras N lojas"
//                  (services/relatorioGrupo)
//   modo 'pagina'  a página "Ver o relatório completo": todas as lojas e o
//                  detalhe (barras por dia, 4 semanas, curva, itens)
//
// Regra de leitura:
//   - total do grupo primeiro, com a comparação só das lojas que venderam
//     nas duas semanas ("das mesmas N lojas");
//   - uma linha por loja onde a decisão é por loja: vendas, estoque baixo,
//     equipe, clientes que sumiram, crediário (e margem, loja online);
//   - só o total onde a decisão é do grupo: formas de pagamento, melhor dia;
//   - loja nova sem venda: "começou em dd/mm", fora da comparação, e um passo.
//
// Links (todos https://app.getaura.com.br/..., como no #899):
//   blocos por loja   ?empresa=<id da loja>
//   blocos do grupo   ?empresa=todas (o app abre o consolidado; PR do app)
//   equipe, crediário, curva ABC, loja online e reativação são sempre por
//   loja: no app essas telas não têm consolidado (o ranking e a curva ABC
//   pedem para escolher a loja; o crediário fica vazio).
//
// Botões: os mesmos do relatório de uma loja (botao(), bulletproof).
// Nenhum nome de cliente final: só quantidades e valores.
// ============================================================
'use strict';

const L = require('../services/emailLayout');
const B = require('./relatorioSemanalBlocos');
const G = require('../services/relatorioGrupo');

const { COR, esc } = L;
const { brlH, n, qtd, plural, pctTexto, botao, botoes, sub, frase, miuda, caixaDoBloco, linkDoApp } = B;

const TODAS = 'todas';
const COR_SOBE = '#15803d';
const COR_DESCE = '#b91c1c';
const COR_BARRA = '#c9b8f5';

// ── Peças ───────────────────────────────────────────────────────

function lojaDoGrupo(r, id) {
  return (r.porLoja && r.porLoja[id]) || {};
}

function delta(p) {
  if (p == null) return '';
  if (Math.round(Math.abs(p)) === 0 && Math.abs(p) < 1) return `<span class="a-ink2" style="color:${COR.tinta2};font-weight:700;">igual</span>`;
  const sobe = p > 0;
  return `<span style="color:${sobe ? COR_SOBE : COR_DESCE};font-weight:700;white-space:nowrap;">${sobe ? '&#9650;' : '&#9660;'} ${pctTexto(p)}</span>`;
}

function etiqueta(texto, { nova = false } = {}) {
  const cor = nova ? '#a15c07' : COR.violeta;
  const fundo = nova ? '#fdf0d5' : COR.cartao;
  const borda = nova ? '#f3d9a4' : '#d8c9fa';
  return `<span style="display:inline-block;font-size:11px;line-height:16px;font-weight:700;color:${cor};background:${fundo};border:1px solid ${borda};border-radius:999px;padding:0 8px;margin-left:4px;white-space:nowrap;">${esc(texto)}</span>`;
}

/** Barrinha da fatia do grupo (tabela: o Outlook não respeita largura de div). */
function fatia(pct) {
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (!v) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;"><tr>` +
    `<td width="${v}%" style="height:6px;line-height:6px;font-size:1px;background:${COR_BARRA};border-radius:3px;">&nbsp;</td>` +
    (v < 100 ? `<td width="${100 - v}%" style="height:6px;line-height:6px;font-size:1px;">&nbsp;</td>` : '') +
    `</tr></table>`;
}

/**
 * Tabela de lojas: cabeçalho e linhas de 3 colunas (a primeira à esquerda,
 * as outras à direita). `linhas`: [[c1, c2, c3, { destaque?, apagada? }]].
 */
function tabelaLojas(cabecalho, linhas, larg = ['46%', '30%', '24%']) {
  const th = cabecalho.map((c, i) =>
    `<td width="${larg[i]}"${i ? ' align="right"' : ''} class="a-soft a-ink2" style="padding:8px 10px;background:${COR.suave};color:${COR.tinta2};font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;${i ? 'text-align:right;' : ''}">${esc(c)}</td>`
  ).join('');
  const tr = linhas.map(([a, b, c, o = {}]) => {
    const fundo = o.destaque ? `background:${COR.suave};` : '';
    const cls = o.destaque ? 'a-soft a-line' : 'a-line';
    const cor = o.apagada ? COR.tinta2 : COR.tinta;
    const peso = o.destaque ? 'font-weight:700;' : '';
    const td = (html, i) =>
      `<td${i ? ' align="right"' : ''} valign="top" class="${cls} ${o.apagada ? 'a-ink2' : 'a-ink'}" style="padding:9px 10px;border-top:1px solid ${COR.linha};${fundo}color:${cor};font-size:13px;line-height:1.45;${peso}${i ? 'text-align:right;' : ''}">${html}</td>`;
    return `<tr>${td(a, 0)}${td(b, 1)}${td(c, 2)}</tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-card a-line" style="margin:0 0 10px;background:${COR.cartao};border:1px solid ${COR.linha};border-radius:10px;border-collapse:separate;table-layout:fixed;">` +
    `<tr>${th}</tr>${tr}</table>`;
}

/** Linha "Loja: texto" com o botão da loja logo abaixo. */
function linhaDaLoja(html, botaoHtml) {
  return `<div style="margin:0 0 8px;">` +
    `<p class="a-ink" style="margin:0 0 6px;color:${COR.tinta};font-size:13.5px;line-height:1.5;">${html}</p>` +
    (botaoHtml ? botoes([botaoHtml]) : '') +
    `</div>`;
}

function nomeForte(loja) {
  return `<strong>${esc(G.capitalizar(loja.nome))}</strong>`;
}

function semanaAnteriorTexto(base, { nome = 'semana anterior' } = {}) {
  if (!base || base.lojas === 0) return null;
  if (base.todasQueVenderam) {
    return base.lojas === 1 ? `${nome} da mesma loja` : `${nome} das mesmas ${n(base.lojas)} lojas`;
  }
  return base.lojas === 1
    ? `${nome} da loja que vendeu nas duas semanas`
    : `${nome} das ${n(base.lojas)} lojas que venderam nas duas semanas`;
}

/** Lojas com dado num bloco, cortadas para o e-mail (as maiores + outras). */
function lojasComDado(r, bloco, temDado, modo) {
  const lojas = r.grupo.lojas.filter((l) => {
    const d = lojaDoGrupo(r, l.companyId)[bloco];
    return d && temDado(d, l);
  });
  return G.cortarLojas(lojas, { modo });
}

// ── Blocos ──────────────────────────────────────────────────────

function blocoVendas(r, { modo, env }) {
  const v = r.vendas;
  const g = r.grupo;
  const partes = [sub('Vendas da semana')];
  partes.push(`<p class="a-ink" style="margin:0 0 4px;color:${COR.tinta};font-size:26px;line-height:1.2;font-weight:700;">${brlH(v.receita)} ${v.receita > 0 ? delta(v.variacaoPct) : ''}</p>`);
  if (v.receita <= 0 && v.vendas <= 0) {
    partes.push(frase('Nenhuma venda registrada nesta semana.'));
  } else {
    const comp = semanaAnteriorTexto(g.base);
    let txt = `Total do grupo, em ${plural(v.vendas, 'venda', 'vendas')}, ticket médio ${brlH(v.ticket)}.`;
    txt += comp && v.variacaoPct != null
      ? ` Comparado com a ${comp} (${brlH(g.base.receitaAnterior)}).`
      : ' Nenhuma loja vendeu nas duas semanas, então não há comparação com a semana anterior.';
    partes.push(miuda(txt));
  }

  const { visiveis, outras } = G.cortarLojas(g.lojas, { modo });
  const linhas = visiveis.map((l) => {
    if (l.nova) {
      return [`${esc(G.capitalizar(l.nome))} ${etiqueta(`começou em ${L.dataCurta(l.criadaEm)}`, { nova: true })}`, 'ainda sem vendas', '—', { apagada: true }];
    }
    if (l.semVenda) return [esc(G.capitalizar(l.nome)), 'sem vendas nesta semana', '—', { apagada: true }];
    const parte = v.receita > 0 ? (l.receita / v.receita) * 100 : 0;
    return [
      `${esc(G.capitalizar(l.nome))} <span class="a-ink2" style="color:${COR.tinta2};font-size:12px;">· ${plural(l.vendas, 'venda', 'vendas')}</span>${fatia(parte)}`,
      `<strong>${brlH(l.receita)}</strong><br><span class="a-ink2" style="color:${COR.tinta2};font-size:11.5px;">${pctTexto(parte)} do grupo</span>`,
      l.naBase ? delta(l.variacaoPct) : `—<br><span class="a-ink2" style="color:${COR.tinta2};font-size:11px;">sem venda na semana passada</span>`,
    ];
  });
  if (outras.length) {
    const rec = outras.reduce((s, l) => s + l.receita, 0);
    const vend = outras.reduce((s, l) => s + l.vendas, 0);
    const parte = v.receita > 0 ? (rec / v.receita) * 100 : 0;
    linhas.push([
      `${G.outrasLojas(outras.length)} <span class="a-ink2" style="color:${COR.tinta2};font-size:12px;">· ${plural(vend, 'venda', 'vendas')}</span>`,
      `<strong>${brlH(rec)}</strong><br><span class="a-ink2" style="color:${COR.tinta2};font-size:11.5px;">${pctTexto(parte)} do grupo</span>`,
      '—',
    ]);
  }
  partes.push(tabelaLojas(['Loja', 'Faturamento', 'Vs. anterior'], linhas));

  if (v.melhorDia && v.receita > 0) {
    const nome = B.DIAS[v.melhorDia.dia] || v.melhorDia.dia;
    partes.push(frase(`${esc(nome)} foi o melhor dia do grupo: ${brlH(v.melhorDia.valor)}` + (v.melhorDia.pctDaSemana != null ? `, ${v.melhorDia.pctDaSemana}% da semana.` : '.')));
  }
  if (modo === 'pagina') {
    if (v.diario && v.diario.length && v.receita > 0) {
      const idx = v.melhorDia ? v.diario.findIndex((d) => d.data === v.melhorDia.data) : -1;
      partes.push(B.barras(v.diario.map((d) => d.valor), v.diario.map((d) => B.DIAS_CURTOS[d.dia] || d.dia), idx));
    }
    if (v.semanas && v.semanas.length === 4 && v.semanas.some((s) => s.receita > 0)) {
      partes.push(sub('Últimas 4 semanas, todas as lojas'));
      partes.push(B.barras(v.semanas.map((s) => s.receita), ['há 3', 'há 2', 'anterior', 'esta'], 3));
      partes.push(B.tabelaSimples(v.semanas.map((s) => [`${esc(L.dataCurta(s.inicio))} a ${esc(L.dataCurta(s.fim))}`, brlH(s.receita)])));
    }
  }
  partes.push(botoes([botao('Ver as vendas do grupo', linkDoApp('/vendas', TODAS, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoMaisVendidos(r, { modo, env }) {
  const m = r.mais_vendidos;
  const top = modo === 'pagina' ? m.top : m.top.slice(0, 3);
  const itens = top.map((p) => {
    const onde = Array.isArray(p.lojas) && p.lojas.length
      ? etiqueta(p.lojas.length === 1 ? G.capitalizar(p.lojas[0]) : `${p.lojas.length} lojas`)
      : '';
    const base = modo === 'pagina'
      ? `${esc(p.nome)} · ${qtd(p.qtd)} un. · ${brlH(p.receita)}`
      : `${esc(p.nome)} · ${qtd(p.qtd)} ${p.qtd === 1 ? 'unidade' : 'unidades'}`;
    return `${base} ${onde}`;
  });
  const partes = [sub('O que mais saiu'), B.lista ? B.lista(itens) : ''];
  const a = m.curva && m.curva.A;
  if (a && a.produtos > 0) {
    partes.push(miuda(`${plural(a.produtos, 'produto faz', 'produtos fazem')} ${a.receitaPct}% do faturamento do grupo (curva A).`));
  }
  if (modo === 'pagina' && m.curva) {
    partes.push(B.tabelaSimples(['A', 'B', 'C'].map((g) => [
      `Curva ${g}`, `${plural(m.curva[g].produtos, 'produto', 'produtos')} · ${m.curva[g].receitaPct}%`,
    ])));
  }
  // A curva ABC do app é por loja (no consolidado ela pede para escolher).
  const { visiveis } = lojasComDado(r, 'mais_vendidos', () => true, modo);
  partes.push(botoes(visiveis.map((l) => botao(`Ver a curva ABC ${G.daLoja(l)}`, linkDoApp('/financeiro/produtos', l.companyId, env)))));
  return caixaDoBloco(partes.join(''));
}

function blocoPagamentos(r, { modo, env }) {
  const b = r.pagamentos_estoque;
  if (!b.pagamentos || !b.pagamentos.length) return '';
  const partes = [sub('Como pagaram')];
  let vis = b.pagamentos;
  if (modo !== 'pagina' && vis.length > 3) {
    const resto = vis.slice(3);
    vis = [...vis.slice(0, 3), { rotulo: 'Outros', valor: resto.reduce((s, x) => s + x.valor, 0), pct: resto.reduce((s, x) => s + x.pct, 0) }];
  }
  partes.push(B.pilha(vis));
  if (modo === 'pagina') {
    partes.push(B.tabelaSimples(vis.map((x) => [esc(x.rotulo), `${x.pct}% · ${brlH(x.valor)}`])));
  } else {
    partes.push(miuda(vis.map((x) => `${esc(x.rotulo)} ${x.pct}% · ${brlH(x.valor)}`).join(' &nbsp;·&nbsp; ')));
  }
  partes.push(miuda('O total das lojas juntas.'));
  partes.push(botoes([botao('Ver o financeiro do grupo', linkDoApp('/financeiro', TODAS, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoAtencao(r, { modo, env }) {
  const b = r.pagamentos_estoque;
  const partes = [];
  const { visiveis, outras } = lojasComDado(r, 'pagamentos_estoque', (d) => d.estoqueBaixo && d.estoqueBaixo.qtd > 0, modo);
  for (const l of visiveis) {
    const eb = lojaDoGrupo(r, l.companyId).pagamentos_estoque.estoqueBaixo;
    let html = `${nomeForte(l)}: ${plural(eb.qtd, 'produto', 'produtos')} com o estoque no mínimo ou abaixo.`;
    if (modo === 'pagina' && eb.itens && eb.itens.length) {
      html += '<br>' + eb.itens.map((it) => `<span class="a-ink2" style="color:${COR.tinta2};font-size:12.5px;">${esc(it.nome)} · ${qtd(it.estoque)} de mínimo ${qtd(it.minimo)}</span>`).join('<br>');
    }
    partes.push(linhaDaLoja(html, botao(`Ver o estoque ${G.daLoja(l)}`, linkDoApp('/estoque', l.companyId, env))));
  }
  if (outras.length) {
    const soma = outras.reduce((s, l) => s + lojaDoGrupo(r, l.companyId).pagamentos_estoque.estoqueBaixo.qtd, 0);
    partes.push(linhaDaLoja(`${G.outrasLojas(outras.length)}: ${plural(soma, 'produto', 'produtos')} com o estoque no mínimo ou abaixo.`, ''));
  }
  if (b && b.contas && b.contas.pagar.qtd > 0) {
    partes.push(linhaDaLoja(
      `${brlH(b.contas.pagar.valor)} em contas a pagar até ${esc(L.dataCurta(b.contas.ate))} (${plural(b.contas.pagar.qtd, 'conta', 'contas')}), somando as lojas.`,
      botao('Ver as contas do grupo', linkDoApp('/financeiro', TODAS, env))
    ));
  }
  if (b && b.contas && b.contas.receber.qtd > 0) {
    partes.push(linhaDaLoja(`${brlH(b.contas.receber.valor)} a receber até ${esc(L.dataCurta(b.contas.ate))} (${plural(b.contas.receber.qtd, 'lançamento', 'lançamentos')}).`, ''));
  }
  if (!partes.length) return '';
  return caixaDoBloco(sub('Pede atenção') + partes.join(''));
}

function blocoEquipe(r, { modo, env }) {
  const max = modo === 'pagina' ? 10 : 3;
  const { visiveis, outras } = lojasComDado(r, 'equipe_margem', (d) => d.equipe && d.equipe.length > 0, modo);
  if (!visiveis.length) return '';
  const partes = [sub('Sua equipe')];
  for (const l of visiveis) {
    const eq = lojaDoGrupo(r, l.companyId).equipe_margem.equipe.slice(0, max);
    const linhas = eq.map((e) => `<span class="a-ink2" style="color:${COR.tinta2};">${esc(e.nome)} · ${brlH(e.receita)} em ${plural(e.vendas, 'venda', 'vendas')}</span>`).join('<br>');
    // A tela de ranking é por loja: o botão abre a loja certa.
    partes.push(linhaDaLoja(`${nomeForte(l)}<br>${linhas}`, botao(`Ver o ranking ${G.daLoja(l)}`, linkDoApp('/vendas?tab=ranking', l.companyId, env))));
  }
  if (outras.length) partes.push(miuda(outras.length === 1 ? 'A equipe da outra loja está na página completa.' : `A equipe das outras ${n(outras.length)} lojas está na página completa.`));
  return caixaDoBloco(partes.join(''));
}

function pctMargem(p) {
  return `${String(p).replace('.', ',')}%`;
}

function blocoMargem(r, { modo }) {
  const em = r.equipe_margem;
  const comMargem = r.grupo.lojas.filter((l) => !l.semVenda && lojaDoGrupo(r, l.companyId).equipe_margem);
  if (!comMargem.length) return '';
  const partes = [sub('Margem bruta')];
  const grupo = em && em.margem && em.margem.atual;
  const { visiveis } = G.cortarLojas(comMargem, { modo });
  const porLoja = visiveis.map((l) => {
    const m = lojaDoGrupo(r, l.companyId).equipe_margem.margem;
    return { l, pct: m && m.atual && m.atual.pct != null ? m.atual.pct : null };
  });
  const comPct = porLoja.filter((x) => x.pct != null);
  if (grupo && grupo.pct != null) {
    const lista = comPct.map((x) => `${esc(G.capitalizar(x.l.nome))} ${pctMargem(x.pct)}`);
    partes.push(frase([`<strong>Grupo ${pctMargem(grupo.pct)}</strong>`, ...lista].join(' &nbsp;·&nbsp; ')));
    const notas = [];
    if (grupo.cobertura < 100) notas.push(`Calculada sobre as vendas com custo cadastrado (${grupo.cobertura}% do faturamento do grupo).`);
    const ant = em.margem.anterior;
    const comp = semanaAnteriorTexto(r.grupo.base, { nome: 'Semana passada,' });
    if (ant && ant.pct != null && comp) notas.push(`${comp}: ${pctMargem(ant.pct)}.`);
    if (notas.length) partes.push(miuda(notas.join(' ')));
  } else {
    partes.push(frase('A margem do grupo aparece aqui quando os produtos vendidos tiverem o custo cadastrado.'));
    if (comPct.length) partes.push(miuda(comPct.map((x) => `${esc(G.capitalizar(x.l.nome))} ${pctMargem(x.pct)}`).join(' &nbsp;·&nbsp; ')));
  }
  const semCusto = porLoja.filter((x) => x.pct == null).map((x) => esc(G.capitalizar(x.l.nome)));
  if (semCusto.length && grupo && grupo.pct != null) {
    partes.push(miuda(`A margem ${semCusto.length === 1 ? G.daLoja(porLoja.find((x) => x.pct == null).l) : `de ${G.listaComE(semCusto)}`} aparece quando os produtos vendidos tiverem o custo cadastrado.`));
  }
  return caixaDoBloco(partes.join(''));
}

function blocoClientes(r, { modo, env }) {
  const c = r.clientes;
  const partes = [sub('Clientes da semana')];
  const lojas = r.grupo.lojas.filter((l) => lojaDoGrupo(r, l.companyId).clientes);
  const { visiveis: visNovos } = G.cortarLojas(lojas, { modo });
  if (c.atendidos > 0) {
    const detalhe = visNovos.map((l) => `${esc(G.capitalizar(l.nome))} ${n(lojaDoGrupo(r, l.companyId).clientes.novos)}`).join(', ');
    partes.push(frase(`Novos: <strong>${n(c.novos)}</strong>${detalhe && lojas.length > 1 ? ` (${detalhe})` : ''} &nbsp;·&nbsp; Voltaram: <strong>${n(c.voltaram)}</strong>`));
  }
  if (c.aniversariantes > 0) {
    const det = visNovos.filter((l) => lojaDoGrupo(r, l.companyId).clientes.aniversariantes > 0)
      .map((l) => `${esc(G.capitalizar(l.nome))} ${n(lojaDoGrupo(r, l.companyId).clientes.aniversariantes)}`).join(', ');
    partes.push(frase(`${plural(c.aniversariantes, 'cliente faz', 'clientes fazem')} aniversário nos próximos 7 dias${det ? ` (${det})` : ''}.`));
  }
  if (c.parados > 0) {
    partes.push(frase(`${plural(c.parados, 'cliente não compra', 'clientes não compram')} há mais de ${c.diasParado} dias:`));
    const { visiveis, outras } = lojasComDado(r, 'clientes', (d) => d.parados > 0, modo);
    for (const l of visiveis) {
      const k = lojaDoGrupo(r, l.companyId).clientes.parados;
      partes.push(linhaDaLoja(`${nomeForte(l)}: ${n(k)}`, botao(`Chamar de volta os clientes ${G.daLoja(l)}`, linkDoApp('/clientes/reativacao', l.companyId, env))));
    }
    if (outras.length) {
      const soma = outras.reduce((s, l) => s + lojaDoGrupo(r, l.companyId).clientes.parados, 0);
      partes.push(linhaDaLoja(`${G.outrasLojas(outras.length)}: ${n(soma)}`, ''));
    }
  }
  partes.push(botoes([botao('Ver os clientes do grupo', linkDoApp('/clientes', TODAS, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoLojaOnline(r, { modo, env }) {
  const { visiveis, outras } = lojasComDado(r, 'loja_online', () => true, modo);
  if (!visiveis.length) return '';
  const partes = [sub('Loja online')];
  for (const l of visiveis) {
    const o = lojaDoGrupo(r, l.companyId).loja_online;
    const txt = o.pedidos > 0
      ? `${nomeForte(l)}: ${plural(o.pedidos, 'pedido confirmado', 'pedidos confirmados')} · ${brlH(o.valor)}`
      : `${nomeForte(l)}: nenhum pedido confirmado nesta semana.`;
    partes.push(linhaDaLoja(txt, botao(`Ver a loja online ${G.daLoja(l)}`, linkDoApp('/canal', l.companyId, env))));
  }
  if (outras.length) {
    const ped = outras.reduce((s, l) => s + lojaDoGrupo(r, l.companyId).loja_online.pedidos, 0);
    partes.push(linhaDaLoja(`${G.outrasLojas(outras.length)}: ${plural(ped, 'pedido confirmado', 'pedidos confirmados')}.`, ''));
  }
  return caixaDoBloco(partes.join(''));
}

function pctDoSaldo(vencido, saldo) {
  if (!(saldo > 0) || !(vencido > 0)) return null;
  return Math.min(100, Math.round((vencido / saldo) * 100));
}

function blocoCrediario(r, { modo, env }) {
  const c = r.crediario;
  const linhasPor = new Map((c.porEmpresa || []).map((x) => [String(x.companyId), x]));
  const lojas = r.grupo.lojas.filter((l) => linhasPor.has(String(l.companyId)));
  const { visiveis, outras } = G.cortarLojas(lojas, { modo });
  const partes = [sub('Crediário')];
  const linha = (nomeHtml, saldo, vencido, o) => {
    const p = pctDoSaldo(vencido, saldo);
    const pct = p != null ? `<br><span class="a-ink2" style="color:${COR.tinta2};font-size:11.5px;font-weight:400;">${p}% do saldo</span>` : '';
    return [nomeHtml, brlH(saldo), `${brlH(vencido)}${pct}`, o];
  };
  const linhas = visiveis.map((l) => {
    const x = linhasPor.get(String(l.companyId));
    return linha(esc(G.capitalizar(l.nome)), x.saldo, x.vencido);
  });
  if (outras.length) {
    const xs = outras.map((l) => linhasPor.get(String(l.companyId)));
    linhas.push(linha(G.outrasLojas(outras.length), xs.reduce((s, x) => s + x.saldo, 0), xs.reduce((s, x) => s + x.vencido, 0)));
  }
  if (lojas.length > 1) linhas.push(linha('Grupo', c.saldo, c.vencido, { destaque: true }));
  partes.push(tabelaLojas(['Loja', 'Saldo em aberto', 'Vencido'], linhas, ['34%', '33%', '33%']));
  const itens = [];
  if (c.recebido > 0 || c.novoFiado > 0) itens.push(`Na semana, ${brlH(c.recebido)} recebidos e ${brlH(c.novoFiado)} de novo fiado${lojas.length > 1 ? ', somando as lojas' : ''}.`);
  if (c.aVencer && c.aVencer.valor > 0) itens.push(`${brlH(c.aVencer.valor)} ${c.aVencer.parcelas === 1 ? 'vence' : 'vencem'} nos próximos ${c.aVencer.dias} dias (${plural(c.aVencer.parcelas, 'parcela', 'parcelas')}).`);
  if (c.clientesAtrasoLongo > 0) itens.push(`${plural(c.clientesAtrasoLongo, 'cliente', 'clientes')} com mais de ${c.diasAtrasoLongo} dias de atraso.`);
  if (c.fiadoNasVendas && c.fiadoNasVendas.vendas > 0) {
    itens.push(`${plural(c.fiadoNasVendas.vendas, 'venda', 'vendas')} no fiado esta semana` + (c.fiadoNasVendas.pct != null ? `, ${c.fiadoNasVendas.pct}% das vendas do grupo.` : '.'));
  }
  if (itens.length) partes.push(miuda(itens.join(' ')));
  // A tela do crediário é por loja (no consolidado ela fica vazia).
  partes.push(botoes(visiveis.map((l) => botao(`Ver o crediário ${G.daLoja(l)}`, linkDoApp('/crediario', l.companyId, env)))));
  return caixaDoBloco(partes.join(''));
}

function blocoLojasNovas(r, { env }) {
  return r.grupo.lojas.filter((l) => l.nova).map((l) => {
    const semProdutos = l.produtos === 0;
    const partes = [
      sub(`${G.capitalizar(l.nome)}, a loja nova`),
      frase(`Criada em ${esc(L.dataCurta(l.criadaEm))}, ainda sem vendas${semProdutos ? ' e sem produtos' : ''}. Ela entra nas contas do grupo assim que vender.`),
    ];
    const passo = semProdutos || l.produtos == null
      ? botao(`Cadastrar os produtos ${G.daLoja(l)}`, linkDoApp('/estoque', l.companyId, env))
      : botao(`Abrir o Caixa ${G.daLoja(l)}`, linkDoApp('/pdv', l.companyId, env));
    partes.push(botoes([passo]));
    return caixaDoBloco(partes.join(''), { destaque: true });
  }).join('\n');
}

// ── Montagem ────────────────────────────────────────────────────

/** É um relatório de várias lojas (consolidado com o grupo montado)? */
function ehGrupo(r) {
  return !!(r && r.grupo && Array.isArray(r.grupo.lojas) && r.grupo.lojas.length > 1);
}

function seguro(nome, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[relatorioMultiloja] bloco ${nome} não renderizou: ${err.message}`);
    return '';
  }
}

/**
 * HTML dos blocos do relatório de várias lojas.
 * @param {object} r  relatorio consolidado (com grupo e porLoja)
 * @param {object} o  { modo: 'email'|'pagina', env }
 */
function renderGrupo(r, { modo = 'email', env = process.env } = {}) {
  if (!ehGrupo(r)) return '';
  const ctx = { modo, env };
  const ligado = new Set(r.blocos || []);
  const tem = (b) => ligado.has(b) && r[b];
  const out = [];
  if (tem('vendas')) out.push(seguro('vendas', () => blocoVendas(r, ctx)));
  if (tem('mais_vendidos')) out.push(seguro('mais_vendidos', () => blocoMaisVendidos(r, ctx)));
  if (tem('pagamentos_estoque')) {
    out.push(seguro('pagamentos', () => blocoPagamentos(r, ctx)));
    out.push(seguro('atencao', () => blocoAtencao(r, ctx)));
  }
  if (tem('equipe_margem')) {
    out.push(seguro('equipe', () => blocoEquipe(r, ctx)));
    out.push(seguro('margem', () => blocoMargem(r, ctx)));
  }
  if (tem('clientes')) out.push(seguro('clientes', () => blocoClientes(r, ctx)));
  if (tem('loja_online')) out.push(seguro('loja_online', () => blocoLojaOnline(r, ctx)));
  if (tem('crediario')) out.push(seguro('crediario', () => blocoCrediario(r, ctx)));
  out.push(seguro('lojas_novas', () => blocoLojasNovas(r, ctx)));
  return out.filter(Boolean).join('\n');
}

/** "Total do grupo e cada loja: vendas, ... da semana". */
function previaDoGrupo(r) {
  const p = B.previaDosBlocos(r);
  return `Total do grupo e cada loja: ${p.charAt(0).toLowerCase()}${p.slice(1)}`;
}

/** Versão em texto: o total e uma linha por loja. */
function textoDoGrupo(r) {
  const g = r.grupo;
  const v = r.vendas;
  const linhas = [`Aura. — ${G.tituloDoGrupo(g)}` + (G.nomesNaLinha(g) ? ` (${G.nomesNaLinha(g)}).` : '.')];
  if (v) linhas.push(`Faturamento do grupo: ${L.brl(v.receita)} | Vendas: ${v.vendas} | Ticket medio: ${L.brl(v.ticket)}`);
  for (const l of G.porFaturamento(g.lojas)) {
    linhas.push(l.nova
      ? `- ${G.capitalizar(l.nome)}: comecou em ${L.dataCurta(l.criadaEm)}, ainda sem vendas`
      : `- ${G.capitalizar(l.nome)}: ${L.brl(l.receita)} em ${l.vendas} vendas`);
  }
  return linhas.join('\n');
}

module.exports = {
  TODAS,
  ehGrupo,
  renderGrupo,
  previaDoGrupo,
  textoDoGrupo,
  tabelaLojas,
};
