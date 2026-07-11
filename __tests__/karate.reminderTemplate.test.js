// ============================================================
// AURA KARATÊ — Fase F4: testes PUROS de karateReminderTemplate (sem DB).
//   - substituição segura (escape de HTML no valor injetado)
//   - variável desconhecida → findUnknownVars não-vazio (a rota PUT
//     reminder-config usa isso pra devolver 422)
// ============================================================
'use strict';

const tpl = require('../src/services/karateReminderTemplate');

describe('escapeHtml', () => {
  it('escapa &, <, >, " e \'', () => {
    expect(tpl.escapeHtml(`<script>alert("x")</script> & 'y'`))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  });
  it('null/undefined vira string vazia', () => {
    expect(tpl.escapeHtml(null)).toBe('');
    expect(tpl.escapeHtml(undefined)).toBe('');
  });
});

describe('findUnknownVars', () => {
  it('template só com variáveis conhecidas → []', () => {
    expect(tpl.findUnknownVars(
      'Olá {{nome}}, {{competencia}} {{valor}} {{vencimento}} {{planos}} {{pix_copia_cola}}'
    )).toEqual([]);
  });
  it('variável desconhecida é reportada (sem duplicar, na ordem de 1ª ocorrência)', () => {
    expect(tpl.findUnknownVars('{{foo}} {{nome}} {{bar}} {{foo}}')).toEqual(['foo', 'bar']);
  });
  it('template vazio/nulo → []', () => {
    expect(tpl.findUnknownVars('')).toEqual([]);
    expect(tpl.findUnknownVars(null)).toEqual([]);
  });
});

describe('renderTemplate — substituição segura (escape de HTML no valor injetado)', () => {
  it('escapa HTML perigoso vindo de uma variável (ex.: nome de dojô mal-intencionado)', () => {
    const out = tpl.renderTemplate('Olá {{nome}}!', { nome: '<img src=x onerror=alert(1)>' });
    expect(out).toBe('Olá &lt;img src=x onerror=alert(1)&gt;!');
    expect(out).not.toContain('<img');
  });
  it('substitui todas as 6 variáveis conhecidas', () => {
    const out = tpl.renderTemplate(
      '{{nome}}|{{competencia}}|{{valor}}|{{vencimento}}|{{planos}}|{{pix_copia_cola}}',
      { nome: 'Dojô A', competencia: '2026', valor: 'R$ 500,00', vencimento: '31/05/2026', planos: 'Anual — R$ 500,00', pix_copia_cola: '000201...' }
    );
    expect(out).toBe('Dojô A|2026|R$ 500,00|31/05/2026|Anual — R$ 500,00|000201...');
  });
  it('variável conhecida ausente em vars vira string vazia (não quebra)', () => {
    expect(tpl.renderTemplate('Olá {{nome}}!', {})).toBe('Olá !');
  });
  it('variável DESCONHECIDA é preservada literalmente (defensivo — validação já rejeitou no PUT)', () => {
    expect(tpl.renderTemplate('{{foo}}', { foo: 'bar' })).toBe('{{foo}}');
  });
  it('template default renderiza com os valores esperados', () => {
    const subject = tpl.renderTemplate(tpl.DEFAULT_SUBJECT_TEMPLATE, { competencia: '2026', valor: 'R$ 500,00' });
    expect(subject).toBe('Lembrete: anuidade 2026 — R$ 500,00');
  });
});

describe('textToHtmlParagraphs', () => {
  it('quebra parágrafos duplos em <p> separados e \\n simples em <br/>', () => {
    const html = tpl.textToHtmlParagraphs('Linha 1\nLinha 2\n\nParágrafo 2');
    expect(html).toContain('Linha 1<br/>Linha 2');
    expect((html.match(/<p /g) || []).length).toBe(2);
  });
});
