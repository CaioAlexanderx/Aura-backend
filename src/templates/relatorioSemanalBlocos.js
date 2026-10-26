// ============================================================
// AURA. — Relatório semanal longo: HTML dos blocos (tq-85, 24/10/2026)
//
// Desenho aprovado: mock "Sua semana · versão 1 (completa, PADRÃO)" da Nina
// (modelos de e-mail, 21/10). Um renderizador só para os dois lugares:
//   modo 'email'   o resumo de cada bloco, dentro do montarEmail
//   modo 'pagina'  o bloco inteiro, na página "Ver relatório completo"
//
// HTML de e-mail: tabelas e estilo inline, sem JS, sem SVG, sem imagem
// externa. Os gráficos são barras de tabela (div com altura em px dentro de
// <td>), como o mock. Cores claras inline e as classes a-* do emailLayout
// para o escuro do aplicativo de e-mail.
//
// Todo link para o app leva ?empresa=<company_id> (tq-92: o app troca a
// empresa pelo link e volta para a tela depois do login, tq-91). Rotas
// conferidas no aura-app (pasta app/(tabs)): /vendas, /vendas?tab=ranking,
// /financeiro/produtos, /financeiro, /clientes, /clientes/reativacao,
// /crediario, /estoque, /canal.
//
// Nenhum nome de cliente final sai daqui: clientes e crediário só com
// quantidades e valores. Nome de produto e de vendedor da própria loja, sim.
//
// Botões em vez de "Ver X →" (Caio, 26/10: "usar botões de hyperlink ao
// invés da frase com setinha. Dessa forma fica claro o CTA"). Cada ação é um
// botão de e-mail à prova de cliente (botao()): tabela com o fundo na <td>,
// mso-padding-alt para o Outlook (que ignora padding no <a>) e o <a> com
// display:block e padding para o resto, área de toque de 44 px de altura.
// Violeta claro, borda fina, sem seta; o verbo diz o que acontece. "Ver o
// relatório completo" continua o único botão preenchido (emailLayout).
// ============================================================
'use strict';

const L = require('../services/emailLayout');

const { COR, esc, brl } = L;
const FONTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Borda fina do botão secundário (violeta claro do mock da Nina).
const BORDA_BOTAO = '#d8c9fa';

// Escuro do aplicativo de e-mail para os botões (vai no <style> do e-mail e
// da página; as cores claras ficam inline).
const ESTILO_ESCURO_BOTAO =
  '.a-lkbg { background: #1d1938 !important; border-color: #4c3f8f !important; }\n' +
  '    .a-lk { color: #c4b5fd !important; }';

const DIAS = { Dom: 'Domingo', Seg: 'Segunda', Ter: 'Terça', Qua: 'Quarta', Qui: 'Quinta', Sex: 'Sexta', Sab: 'Sábado' };
const DIAS_CURTOS = { Dom: 'dom', Seg: 'seg', Ter: 'ter', Qua: 'qua', Qui: 'qui', Sex: 'sex', Sab: 'sáb' };

function appUrl(env = process.env) {
  return String(env.APP_URL || L.APP_URL_PADRAO).replace(/\/+$/, '');
}

/** Link para uma tela do app, sempre com ?empresa=<company_id>. */
function linkDoApp(rota, companyId, env = process.env) {
  const r = String(rota || '/').startsWith('/') ? String(rota || '/') : '/' + rota;
  const sep = r.includes('?') ? '&' : '?';
  return `${appUrl(env)}${r}${companyId ? `${sep}empresa=${encodeURIComponent(companyId)}` : ''}`;
}

// ── Peças ───────────────────────────────────────────────────────

/** R$ com espaço que não quebra (no celular o "R$" não fica sozinho na linha). */
function brlH(v) {
  return esc(brl(v)).replace('R$ ', 'R$$&nbsp;');
}

function n(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function qtd(v) {
  const x = Math.round((Number(v) || 0) * 100) / 100;
  return Number.isInteger(x) ? n(x) : String(x).replace('.', ',');
}

function plural(k, um, varios) {
  return `${n(k)} ${k === 1 ? um : varios}`;
}

function pctTexto(p) {
  const a = Math.abs(Number(p) || 0);
  if (a > 0 && a < 1) return 'menos de 1%';
  return `${Math.round(a)}%`;
}

/**
 * Botão secundário do e-mail (bulletproof). `texto` é texto puro.
 * Altura: 12 + 18 + 12 de padding/linha + 2 de borda = 44 px.
 * display:inline-block na tabela: lado a lado e quebrando linha no Gmail e
 * no Apple Mail; o Outlook (Word) ignora e empilha, o que também serve.
 */
function botao(texto, href) {
  const url = L.urlSegura(href);
  if (!url || !texto) return '';
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline-block;vertical-align:top;margin:0 8px 8px 0;border-collapse:separate;">` +
    `<tr><td align="center" valign="middle" bgcolor="${COR.suave}" class="a-lkbg" style="background:${COR.suave};border:1px solid ${BORDA_BOTAO};border-radius:9px;mso-padding-alt:12px 16px;">` +
    `<a href="${esc(url)}" class="a-lk" style="display:block;padding:12px 16px;color:${COR.violeta};font-family:${FONTE};font-size:14px;line-height:18px;font-weight:700;text-decoration:none;border-radius:9px;mso-line-height-rule:exactly;">${esc(texto)}</a>` +
    `</td></tr></table>`;
}

/** Linha de botões (font-size 0 tira o espaço entre os inline-block). */
function botoes(lista) {
  const vis = (lista || []).filter(Boolean);
  return vis.length ? `<div style="margin:6px 0 0;font-size:0;line-height:0;">${vis.join('')}</div>` : '';
}

function sub(texto) {
  return `<p class="a-ink2" style="margin:0 0 8px;color:${COR.tinta2};font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;">${esc(texto)}</p>`;
}

function frase(html, estilo = '') {
  return `<p class="a-ink" style="margin:0 0 8px;color:${COR.tinta};font-size:13.5px;line-height:1.55;${estilo}">${html}</p>`;
}

function miuda(html) {
  return `<p class="a-ink2" style="margin:0 0 8px;color:${COR.tinta2};font-size:12px;line-height:1.5;">${html}</p>`;
}

function lista(itens) {
  const lis = itens.filter(Boolean).map((t) => `<li class="a-ink2" style="margin:0 0 4px;color:${COR.tinta2};font-size:13px;line-height:1.5;">${t}</li>`).join('');
  return lis ? `<ul style="margin:0 0 8px;padding-left:18px;">${lis}</ul>` : '';
}

/** Caixa suave de um bloco. */
function caixaDoBloco(conteudo, { destaque = false } = {}) {
  const borda = destaque ? COR.violeta : COR.linha;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-soft" style="background:${COR.suave};border:1px solid ${borda};border-radius:12px;margin:0 0 14px;">` +
    `<tr><td style="padding:14px 16px;">${conteudo}</td></tr></table>`;
}

/**
 * Linha de 2 ou 3 números (rótulo pequeno em cima, valor grande embaixo).
 * Células fluidas (inline-block com largura mínima): lado a lado no
 * computador e duas por linha no celular, sem estourar a largura e sem o
 * "R$" sozinho numa linha.
 */
function numeros(itens) {
  const vis = itens.filter(Boolean);
  const w = vis.length >= 3 ? '31%' : '47%';
  const cels = vis.map((it) => {
    const valor = it.valorHtml != null ? it.valorHtml : esc(it.valor).replace(/R\$ /g, 'R$$&nbsp;');
    return `<div class="a-card" style="display:inline-block;vertical-align:top;box-sizing:border-box;width:${w};min-width:128px;margin:0 6px 6px 0;padding:9px 10px;background:${COR.cartao};border:1px solid ${COR.linha};border-radius:10px;">` +
      `<span class="a-ink2" style="display:block;font-size:11px;line-height:1.5;color:${COR.tinta2};">${esc(it.rotulo)}</span>` +
      `<span class="a-ink" style="display:block;font-size:16px;font-weight:700;color:${COR.tinta};line-height:1.3;">${valor}</span>` +
      `</div>`;
  }).join('');
  return `<div style="margin:0 0 6px;font-size:0;line-height:0;">${cels}</div>`;
}

/**
 * Barras verticais em tabela. `valores` em R$; `destaque` = índice violeta.
 * Altura máxima 64 px; valor zero vira um traço de 2 px.
 */
function barras(valores, rotulos, destaque) {
  const max = Math.max(0, ...valores);
  const w = Math.floor(100 / Math.max(valores.length, 1));
  const colunas = valores.map((v, i) => {
    const h = max > 0 ? Math.max(2, Math.round((v / max) * 64)) : 2;
    const cor = i === destaque ? COR.violeta : COR.linha;
    // No escuro do app de e-mail, a barra comum escurece (a-card); a violeta fica.
    const classe = i === destaque ? '' : ' class="a-card a-bar"';
    return `<td width="${w}%" valign="bottom" align="center" style="padding:0 3px;height:70px;">` +
      `<div${classe} style="height:${h}px;line-height:${h}px;font-size:1px;background:${cor};border-radius:4px 4px 0 0;">&nbsp;</div></td>`;
  }).join('');
  const legendas = rotulos.map((r) => `<td align="center" class="a-ink2" style="padding:4px 2px 0;font-size:10.5px;color:${COR.tinta2};">${esc(r)}</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;table-layout:fixed;"><tr>${colunas}</tr><tr>${legendas}</tr></table>`;
}

/** Barra horizontal empilhada (formas de pagamento). */
function pilha(itens) {
  const cores = [COR.violeta, '#8b5cf6', '#c4b5fd', COR.linha];
  const vis = itens.filter((x) => x.pct > 0);
  if (!vis.length) return '';
  const tds = vis.map((x, i) => `<td width="${Math.max(1, x.pct)}%"${i >= cores.length - 1 ? ' class="a-card a-bar"' : ''} style="height:12px;line-height:12px;font-size:1px;background:${cores[Math.min(i, cores.length - 1)]};">&nbsp;</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px;border-radius:6px;overflow:hidden;"><tr>${tds}</tr></table>`;
}

/** Medidor (uma barra de 0 a 100%). */
function medidor(p) {
  const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
  const resto = 100 - v;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 8px;"><tr>` +
    (v > 0 ? `<td width="${v}%" style="height:8px;line-height:8px;font-size:1px;background:${COR.violeta};border-radius:6px 0 0 6px;">&nbsp;</td>` : '') +
    (resto > 0 ? `<td width="${resto}%" class="a-card a-bar" style="height:8px;line-height:8px;font-size:1px;background:${COR.linha};border-radius:0 6px 6px 0;">&nbsp;</td>` : '') +
    `</tr></table>`;
}

/** Tabela rótulo/valor (página). */
function tabelaSimples(linhas) {
  const tr = linhas.map(([rot, val], i, arr) => {
    const borda = i < arr.length - 1 ? `border-bottom:1px solid ${COR.linha};` : '';
    return `<tr><td class="a-ink2 a-line" style="padding:6px 0;${borda}color:${COR.tinta2};font-size:13px;">${rot}</td>` +
      `<td class="a-ink a-line" align="right" style="padding:6px 0;${borda}color:${COR.tinta};font-size:13px;font-weight:700;text-align:right;white-space:nowrap;">${val}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${tr}</table>`;
}

// ── Blocos ──────────────────────────────────────────────────────

function blocoVendas(v, { modo, companyId, env }) {
  const partes = [sub('Vendas da semana')];
  partes.push(numeros([
    { rotulo: 'Vendas', valor: n(v.vendas) },
    { rotulo: 'Faturamento', valor: brl(v.receita) },
    { rotulo: 'Ticket médio', valor: brl(v.ticket) },
  ]));
  if (v.receita <= 0 && v.vendas <= 0) {
    partes.push(frase('Nenhuma venda registrada nesta semana.'));
  } else if (v.variacaoPct == null) {
    partes.push(frase('Na semana anterior não houve venda para comparar.'));
  } else if (v.variacaoPct === 0) {
    partes.push(frase('O mesmo faturamento da semana anterior.'));
  } else {
    const sobe = v.variacaoPct > 0;
    const cor = sobe ? '#15803d' : '#b91c1c';
    partes.push(frase(
      `<span style="color:${cor};font-weight:700;">${sobe ? '&#9650;' : '&#9660;'} ${pctTexto(v.variacaoPct)} ${sobe ? 'a mais' : 'a menos'}</span> que na semana anterior (${brlH(v.receitaAnterior)}).`
    ));
  }
  if (v.diario && v.diario.length && v.receita > 0) {
    const idx = v.melhorDia ? v.diario.findIndex((d) => d.data === v.melhorDia.data) : -1;
    partes.push(barras(v.diario.map((d) => d.valor), v.diario.map((d) => DIAS_CURTOS[d.dia] || d.dia), idx));
    if (v.melhorDia) {
      const nome = DIAS[v.melhorDia.dia] || v.melhorDia.dia;
      partes.push(miuda(`${esc(nome)} foi o melhor dia: ${brlH(v.melhorDia.valor)}` + (v.melhorDia.pctDaSemana != null ? `, ${v.melhorDia.pctDaSemana}% da semana.` : '.')));
    }
  }
  if (modo === 'pagina' && v.semanas && v.semanas.length === 4 && v.semanas.some((s) => s.receita > 0)) {
    partes.push(sub('Últimas 4 semanas'));
    partes.push(barras(v.semanas.map((s) => s.receita), ['há 3', 'há 2', 'anterior', 'esta'], 3));
    partes.push(tabelaSimples(v.semanas.map((s) => [`${esc(L.dataCurta(s.inicio))} a ${esc(L.dataCurta(s.fim))}`, brlH(s.receita)])));
  }
  partes.push(botoes([botao('Ver as vendas', linkDoApp('/vendas', companyId, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoMaisVendidos(m, { modo, companyId, env }) {
  const top = modo === 'pagina' ? m.top : m.top.slice(0, 3);
  const itens = top.map((p) => modo === 'pagina'
    ? `${esc(p.nome)} · ${qtd(p.qtd)} un. · ${brlH(p.receita)}`
    : `${esc(p.nome)} · ${qtd(p.qtd)} ${p.qtd === 1 ? 'unidade' : 'unidades'}`);
  const partes = [sub('O que mais saiu'), lista(itens)];
  const a = m.curva && m.curva.A;
  if (a && a.produtos > 0) {
    partes.push(miuda(`${plural(a.produtos, 'produto faz', 'produtos fazem')} ${a.receitaPct}% do faturamento da semana (curva A).`));
  }
  if (modo === 'pagina' && m.curva) {
    partes.push(tabelaSimples(['A', 'B', 'C'].map((g) => [
      `Curva ${g}`, `${plural(m.curva[g].produtos, 'produto', 'produtos')} · ${m.curva[g].receitaPct}%`,
    ])));
  }
  partes.push(botoes([botao('Ver a curva ABC completa', linkDoApp('/financeiro/produtos', companyId, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoPagamentosEstoque(b, { modo, companyId, env }) {
  const partes = [];
  if (b.pagamentos && b.pagamentos.length) {
    partes.push(sub('Como pagaram'));
    let vis = b.pagamentos;
    if (modo !== 'pagina' && vis.length > 3) {
      const resto = vis.slice(3);
      vis = [...vis.slice(0, 3), {
        rotulo: 'Outros',
        valor: resto.reduce((s, x) => s + x.valor, 0),
        pct: resto.reduce((s, x) => s + x.pct, 0),
      }];
    }
    partes.push(pilha(vis));
    if (modo === 'pagina') {
      partes.push(tabelaSimples(vis.map((x) => [esc(x.rotulo), `${x.pct}% · ${brlH(x.valor)}`])));
    } else {
      partes.push(miuda(vis.map((x) => `${esc(x.rotulo)} ${x.pct}% · ${brlH(x.valor)}`).join(' &nbsp;·&nbsp; ')));
    }
  }
  const atencao = [];
  if (b.estoqueBaixo) {
    atencao.push(`${plural(b.estoqueBaixo.qtd, 'produto está', 'produtos estão')} com o estoque no mínimo ou abaixo.`);
  }
  if (b.contas && b.contas.pagar.qtd > 0) {
    atencao.push(`${brlH(b.contas.pagar.valor)} em contas a pagar até ${esc(L.dataCurta(b.contas.ate))} (${plural(b.contas.pagar.qtd, 'conta', 'contas')}).`);
  }
  if (b.contas && b.contas.receber.qtd > 0) {
    atencao.push(`${brlH(b.contas.receber.valor)} a receber até ${esc(L.dataCurta(b.contas.ate))} (${plural(b.contas.receber.qtd, 'lançamento', 'lançamentos')}).`);
  }
  if (atencao.length) {
    partes.push(sub('Pede atenção'));
    partes.push(lista(atencao));
  }
  if (modo === 'pagina' && b.estoqueBaixo && b.estoqueBaixo.itens && b.estoqueBaixo.itens.length) {
    partes.push(tabelaSimples(b.estoqueBaixo.itens.map((it) => [
      esc(it.nome) + (it.empresa ? ` <span style="color:${COR.tinta2};font-weight:400;">(${esc(it.empresa)})</span>` : ''),
      `${qtd(it.estoque)} de mínimo ${qtd(it.minimo)}`,
    ])));
  }
  if (!partes.length) return '';
  // Um botão por tela de destino (Nina, 26/10): o "Ver o financeiro" fica
  // só com as contas a pagar ("Pede atenção"); formas de pagamento e margem
  // não repetem o botão.
  partes.push(botoes([
    b.estoqueBaixo ? botao('Ver o estoque', linkDoApp('/estoque', companyId, env)) : '',
    b.contas && b.contas.pagar.qtd > 0 ? botao('Ver o financeiro', linkDoApp('/financeiro', companyId, env)) : '',
  ]));
  return caixaDoBloco(partes.join(''));
}

function linhasDaEquipe(equipe, max) {
  return equipe.slice(0, max).map((e) => `${esc(e.nome)} · ${brlH(e.receita)} em ${plural(e.vendas, 'venda', 'vendas')}`);
}

function blocoEquipeMargem(b, { modo, companyId, env }) {
  const partes = [];
  const max = modo === 'pagina' ? 10 : 3;
  if (b.porEmpresa && b.porEmpresa.length) {
    const comEquipe = b.porEmpresa.filter((x) => x.equipe.length);
    if (comEquipe.length) {
      partes.push(sub('Sua equipe'));
      for (const x of comEquipe) {
        partes.push(frase(`<strong>${esc(x.nome)}</strong>`, 'margin:0 0 4px;'));
        partes.push(lista(linhasDaEquipe(x.equipe, max)));
        partes.push(botoes([botao('Ver o ranking', linkDoApp('/vendas?tab=ranking', x.companyId, env))]));
      }
    }
  } else if (b.equipe && b.equipe.length) {
    partes.push(sub('Sua equipe'));
    partes.push(lista(linhasDaEquipe(b.equipe, max)));
    partes.push(botoes([botao('Ver o relatório da equipe', linkDoApp('/vendas?tab=ranking', companyId, env))]));
  }
  if (b.margem && b.margem.atual) {
    const a = b.margem.atual;
    const ant = b.margem.anterior;
    if (partes.length) partes.push('<div style="height:8px;line-height:8px;font-size:1px;">&nbsp;</div>');
    if (a.pct == null) {
      partes.push(sub('Margem bruta'));
      partes.push(frase('A margem aparece aqui quando os produtos vendidos tiverem o custo cadastrado.'));
    } else {
      partes.push(numeros([
        { rotulo: 'Margem bruta da semana', valor: `${String(a.pct).replace('.', ',')}%` },
        { rotulo: 'Semana passada', valor: ant && ant.pct != null ? `${String(ant.pct).replace('.', ',')}%` : '—' },
      ]));
      const notas = [];
      if (a.cobertura < 100) notas.push(`Calculada sobre as vendas com custo cadastrado (${a.cobertura}% do faturamento).`);
      if (!ant || ant.pct == null) notas.push('Na semana passada não houve venda com custo suficiente para comparar.');
      if (notas.length) partes.push(miuda(notas.join(' ')));
    }
    // Sem botão: o "Ver o financeiro" fica só com as contas a pagar.
  }
  return partes.length ? caixaDoBloco(partes.join('')) : '';
}

function blocoClientes(c, { companyId, env }) {
  const partes = [];
  if (c.atendidos > 0) {
    partes.push(sub('Clientes da semana'));
    partes.push(numeros([
      { rotulo: 'Clientes novos', valor: n(c.novos) },
      { rotulo: 'Clientes que voltaram', valor: n(c.voltaram) },
    ]));
  }
  const itens = [];
  if (c.aniversariantes > 0) {
    itens.push(`${plural(c.aniversariantes, 'cliente faz', 'clientes fazem')} aniversário nos próximos 7 dias.`);
  }
  if (c.parados > 0) {
    itens.push(`${plural(c.parados, 'cliente não compra', 'clientes não compram')} há mais de ${c.diasParado} dias.`);
  }
  if (itens.length) {
    if (!partes.length) partes.push(sub('Clientes'));
    partes.push(lista(itens));
  }
  if (!partes.length) return '';
  partes.push(botoes([
    c.parados > 0 ? botao('Chamar de volta', linkDoApp('/clientes/reativacao', companyId, env)) : '',
    botao(c.aniversariantes > 0 ? 'Ver os aniversariantes' : 'Ver meus clientes', linkDoApp('/clientes', companyId, env)),
  ]));
  return caixaDoBloco(partes.join(''));
}

function blocoLojaOnline(o, { companyId, env }) {
  const partes = [sub('Loja online')];
  if (o.pedidos > 0) {
    partes.push(numeros([
      { rotulo: 'Pedidos confirmados', valor: n(o.pedidos) },
      { rotulo: 'Valor dos pedidos', valor: brl(o.valor) },
    ]));
  } else {
    partes.push(frase('Nenhum pedido confirmado na loja online nesta semana.'));
  }
  partes.push(botoes([botao('Ver a loja online', linkDoApp('/canal', companyId, env))]));
  return caixaDoBloco(partes.join(''));
}

function blocoCrediario(c, { modo, companyId, env }) {
  const partes = [sub('Crediário da semana')];
  partes.push(numeros([
    { rotulo: 'Recebido', valor: brl(c.recebido) },
    { rotulo: 'Novo fiado', valor: brl(c.novoFiado) },
  ]));
  partes.push(numeros([
    { rotulo: 'Saldo em aberto', valor: brl(c.saldo) },
    { rotulo: 'Vencido', valor: brl(c.vencido) + (c.pctVencido != null && c.vencido > 0 ? ` · ${c.pctVencido}%` : '') },
  ]));
  const itens = [];
  if (c.aVencer && c.aVencer.valor > 0) {
    itens.push(`${brlH(c.aVencer.valor)} ${c.aVencer.parcelas === 1 ? 'vence' : 'vencem'} nos próximos ${c.aVencer.dias} dias (${plural(c.aVencer.parcelas, 'parcela', 'parcelas')})`);
  }
  if (c.clientesAtrasoLongo > 0) {
    itens.push(`${plural(c.clientesAtrasoLongo, 'cliente', 'clientes')} com mais de ${c.diasAtrasoLongo} dias de atraso`);
  }
  if (c.fiadoNasVendas && c.fiadoNasVendas.vendas > 0) {
    itens.push(`${plural(c.fiadoNasVendas.vendas, 'venda', 'vendas')} no fiado esta semana` + (c.fiadoNasVendas.pct != null ? `, ${c.fiadoNasVendas.pct}% das vendas` : ''));
  }
  partes.push(lista(itens));
  if (modo === 'pagina' && c.porEmpresa && c.porEmpresa.length > 1) {
    partes.push(tabelaSimples(c.porEmpresa.map((x) => [
      esc(x.nome),
      `saldo ${brlH(x.saldo)} · vencido ${brlH(x.vencido)}`,
    ])));
    // A tela do crediário é por loja: um botão por loja.
    partes.push(botoes(c.porEmpresa.map((x) => botao(`Ver o crediário: ${x.nome}`, linkDoApp('/crediario', x.companyId, env)))));
    return caixaDoBloco(partes.join(''));
  }
  partes.push(botoes([botao('Ver o crediário', linkDoApp('/crediario', companyId, env))]));
  return caixaDoBloco(partes.join(''));
}

const ORDEM = ['vendas', 'mais_vendidos', 'pagamentos_estoque', 'equipe_margem', 'clientes', 'loja_online', 'crediario'];
const RENDER = {
  vendas: blocoVendas,
  mais_vendidos: blocoMaisVendidos,
  pagamentos_estoque: blocoPagamentosEstoque,
  equipe_margem: blocoEquipeMargem,
  clientes: blocoClientes,
  loja_online: blocoLojaOnline,
  crediario: blocoCrediario,
};

/**
 * HTML de todos os blocos que existem em `dados` (e estão em dados.blocos).
 * @param {object} dados   saída de relatorioBlocos (dadosDosBlocos/consolidarBlocos)
 * @param {object} o       { modo: 'email'|'pagina', companyId, env }
 */
function renderBlocos(dados, { modo = 'email', companyId, env = process.env } = {}) {
  if (!dados) return '';
  const ligados = new Set(dados.blocos || []);
  return ORDEM
    .filter((b) => ligados.has(b) && dados[b])
    .map((b) => {
      try {
        return RENDER[b](dados[b], { modo, companyId, env });
      } catch (err) {
        console.error(`[relatorioSemanalBlocos] bloco ${b} não renderizou: ${err.message}`);
        return '';
      }
    })
    .join('\n');
}

/** Blocos que de fato aparecem (para a prévia do e-mail e os testes). */
function blocosVisiveis(dados) {
  if (!dados) return [];
  const ligados = new Set(dados.blocos || []);
  return ORDEM.filter((b) => ligados.has(b) && dados[b]);
}

const NOMES_NA_PREVIA = {
  vendas: 'vendas', mais_vendidos: 'mais vendidos', pagamentos_estoque: 'estoque e contas',
  equipe_margem: 'equipe e margem', clientes: 'clientes', loja_online: 'loja online', crediario: 'crediário',
};

/** "Vendas, mais vendidos, estoque e contas e crediário da semana". */
function previaDosBlocos(dados) {
  const nomes = blocosVisiveis(dados).map((b) => NOMES_NA_PREVIA[b]);
  if (!nomes.length) return 'O resumo da sua semana';
  const txt = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
  return `${txt.charAt(0).toUpperCase()}${txt.slice(1)} da semana`;
}

module.exports = {
  ORDEM,
  ESTILO_ESCURO_BOTAO,
  FONTE,
  linkDoApp,
  botao,
  botoes,
  brlH,
  n,
  qtd,
  plural,
  pctTexto,
  lista,
  medidor,
  pilha,
  DIAS,
  DIAS_CURTOS,
  renderBlocos,
  blocosVisiveis,
  previaDosBlocos,
  barras,
  numeros,
  caixaDoBloco,
  sub,
  frase,
  miuda,
  tabelaSimples,
};
