// ============================================================
// AURA. — Payslip PDF Generator (PDFKit)
// Generates a professional payslip PDF as a Buffer
// ============================================================
const PDFDocument = require('pdfkit');

const VIOLET = '#6d28d9';
const VIOLET_LIGHT = '#ede9fe';
const GREEN = '#059669';
const RED = '#dc2626';
const GRAY = '#64748b';
const DARK = '#1a1a2e';

const BRL = (v) => `R$ ${parseFloat(v || 0).toFixed(2).replace('.', ',')}`;

/**
 * @param {Object} opts
 * @param {string} opts.employeeName
 * @param {string} opts.employeeRole
 * @param {string} opts.employeeCpf
 * @param {string} opts.employeeAdmDate
 * @param {string} opts.companyName
 * @param {string} opts.companyCnpj
 * @param {string} opts.type - mensal|ferias|decimo_terceiro
 * @param {string} opts.period - e.g. "abril de 2026"
 * @param {number} opts.salary
 * @param {Array}  opts.proventos - [{label, value}]
 * @param {Array}  opts.descontos - [{label, value}]
 * @param {number} opts.totalProventos
 * @param {number} opts.totalDescontos
 * @param {number} opts.liquid
 * @param {string} [opts.extra] - e.g. "FGTS sobre ferias: R$ 120,00"
 * @returns {Promise<Buffer>}
 */
async function generatePayslipPdf(opts) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 100; // usable width
      const typeLabels = { mensal: 'Mensal', ferias: 'Ferias', decimo_terceiro: '13o Salario' };

      // ── Header bar ──
      doc.rect(50, 40, W, 4).fill(VIOLET);
      doc.fontSize(22).font('Helvetica-Bold').fillColor(VIOLET).text('aura.', 50, 56);
      doc.fontSize(9).font('Helvetica').fillColor(GRAY)
        .text(opts.companyName || 'Empresa', 300, 56, { width: W - 250, align: 'right' });
      if (opts.companyCnpj) {
        doc.text(`CNPJ: ${opts.companyCnpj}`, 300, 68, { width: W - 250, align: 'right' });
      }
      doc.text(`Emitido em: ${new Date().toLocaleDateString('pt-BR')}`, 300, 80, { width: W - 250, align: 'right' });

      // ── Title ──
      doc.moveDown(1.5);
      const titleY = doc.y;
      doc.fontSize(16).font('Helvetica-Bold').fillColor(DARK)
        .text(`Holerite — ${typeLabels[opts.type] || 'Mensal'}`, 50, titleY);
      doc.fontSize(10).font('Helvetica').fillColor(GRAY)
        .text(`Competencia: ${opts.period || ''}`, 50, titleY + 22);

      // ── Employee info box ──
      const infoY = titleY + 48;
      doc.rect(50, infoY, W, 50).fill(VIOLET_LIGHT);
      doc.rect(50, infoY, W, 50).lineWidth(0.5).stroke('#ddd6fe');
      const col1 = 60, col2 = 300;
      doc.fontSize(9).font('Helvetica').fillColor(GRAY);
      doc.font('Helvetica-Bold').fillColor(DARK).text('Nome:', col1, infoY + 10, { continued: true }).font('Helvetica').fillColor(GRAY).text(` ${opts.employeeName || ''}`);
      doc.font('Helvetica-Bold').fillColor(DARK).text('Cargo:', col2, infoY + 10, { continued: true }).font('Helvetica').fillColor(GRAY).text(` ${opts.employeeRole || 'Colaborador'}`);
      doc.font('Helvetica-Bold').fillColor(DARK).text('CPF:', col1, infoY + 28, { continued: true }).font('Helvetica').fillColor(GRAY).text(` ${opts.employeeCpf || '—'}`);
      doc.font('Helvetica-Bold').fillColor(DARK).text('Admissao:', col2, infoY + 28, { continued: true }).font('Helvetica').fillColor(GRAY).text(` ${opts.employeeAdmDate || '—'}`);

      // ── Table helper ──
      let tableY = infoY + 70;
      function sectionHeader(title) {
        doc.fontSize(9).font('Helvetica-Bold').fillColor(VIOLET).text(title.toUpperCase(), 50, tableY);
        tableY += 14;
        doc.rect(50, tableY, W, 0.5).fill('#ddd6fe');
        tableY += 6;
      }
      function tableRow(label, value, color) {
        doc.fontSize(10).font('Helvetica').fillColor(DARK).text(label, 60, tableY);
        doc.font('Helvetica').fillColor(color || DARK).text(value, 400, tableY, { width: W - 360, align: 'right' });
        tableY += 18;
        doc.rect(60, tableY - 4, W - 20, 0.3).fill('#e5e7eb');
      }
      function totalRow(label, value, color) {
        doc.rect(50, tableY - 2, W, 22).fill(VIOLET_LIGHT);
        doc.rect(50, tableY - 2, W, 0.8).fill(VIOLET);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(label, 60, tableY + 2);
        doc.font('Helvetica-Bold').fillColor(color || DARK).text(value, 400, tableY + 2, { width: W - 360, align: 'right' });
        tableY += 28;
      }

      // ── Proventos ──
      sectionHeader('Proventos');
      for (const p of (opts.proventos || [])) {
        tableRow(p.label, BRL(p.value), GREEN);
      }
      totalRow('Total proventos', BRL(opts.totalProventos));

      // ── Descontos ──
      tableY += 6;
      sectionHeader('Descontos');
      for (const d of (opts.descontos || [])) {
        tableRow(d.label, d.value > 0 ? `-${BRL(d.value)}` : 'Isento', d.value > 0 ? RED : GRAY);
      }
      totalRow('Total descontos', `-${BRL(opts.totalDescontos)}`, RED);

      // ── Extra info ──
      if (opts.extra) {
        tableY += 4;
        doc.rect(50, tableY, W, 24).fill(VIOLET_LIGHT);
        doc.rect(50, tableY, W, 24).lineWidth(0.5).stroke('#ddd6fe');
        doc.fontSize(9).font('Helvetica').fillColor(VIOLET).text(opts.extra, 60, tableY + 6);
        tableY += 32;
      }

      // ── Liquid box ──
      tableY += 8;
      const gradient = doc.linearGradient(50, tableY, 50 + W, tableY);
      gradient.stop(0, VIOLET).stop(1, '#7c3aed');
      doc.rect(50, tableY, W, 48).fill(gradient);
      doc.roundedRect(50, tableY, W, 48, 8).fill(gradient);
      const liquidLabel = opts.type === 'ferias' ? 'Liquido ferias' : opts.type === 'decimo_terceiro' ? 'Liquido 13o' : 'Salario liquido';
      doc.fontSize(12).font('Helvetica').fillColor('#ffffffcc').text(liquidLabel, 66, tableY + 16);
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff').text(BRL(opts.liquid), 300, tableY + 10, { width: W - 266, align: 'right' });

      // ── Footer ──
      tableY += 64;
      doc.rect(50, tableY, W, 0.3).fill('#ddd');
      doc.fontSize(7).font('Helvetica').fillColor('#aaa')
        .text('Aura. — Holerite estimado para apoio contabil. Nao substitui documento oficial.', 50, tableY + 6)
        .text(opts.period || '', 400, tableY + 6, { width: W - 350, align: 'right' });

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generatePayslipPdf };
