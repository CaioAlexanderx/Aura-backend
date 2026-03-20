const INSS_BRACKETS_2026 = [
  { min: 0,       max: 1518.00,  rate: 0.075 },
  { min: 1518.01, max: 2793.88,  rate: 0.09  },
  { min: 2793.89, max: 4190.83,  rate: 0.12  },
  { min: 4190.84, max: 8157.41,  rate: 0.14  },
];

const INSS_TETO_2026 = 8157.41;
const INSS_MAX_2026  = 951.63;
const FGTS_RATE      = 0.08;

const IRRF_BRACKETS_2026 = [
  { min: 0,       max: 2259.20,  rate: 0,     deduction: 0      },
  { min: 2259.21, max: 2826.65,  rate: 0.075, deduction: 169.44 },
  { min: 2826.66, max: 3751.05,  rate: 0.15,  deduction: 381.44 },
  { min: 3751.06, max: 4664.68,  rate: 0.225, deduction: 662.77 },
  { min: 4664.69, max: Infinity, rate: 0.275, deduction: 896.00 },
];

const IRRF_DEDUCTION_PER_DEPENDENT = 189.59;

function calculateINSS(grossSalary) {
  if (grossSalary <= 0) return 0;
  const base = Math.min(grossSalary, INSS_TETO_2026);
  let inss = 0;
  let remaining = base;
  for (const bracket of INSS_BRACKETS_2026) {
    if (remaining <= 0) break;
    const bracketSize = bracket.max - bracket.min;
    const taxable = Math.min(remaining, bracketSize);
    inss += taxable * bracket.rate;
    remaining -= taxable;
  }
  return Math.min(parseFloat(inss.toFixed(2)), INSS_MAX_2026);
}

function calculateIRRF(grossSalary, inss, dependents = 0) {
  if (grossSalary <= 0) return 0;
  const deductionDependents = dependents * IRRF_DEDUCTION_PER_DEPENDENT;
  const base = grossSalary - inss - deductionDependents;
  if (base <= 0) return 0;
  for (const bracket of IRRF_BRACKETS_2026) {
    if (base <= bracket.max) {
      const irrf = base * bracket.rate - bracket.deduction;
      return Math.max(parseFloat(irrf.toFixed(2)), 0);
    }
  }
  return 0;
}

function calculateFGTS(grossSalary) {
  if (grossSalary <= 0) return 0;
  return parseFloat((grossSalary * FGTS_RATE).toFixed(2));
}

function calculatePayroll(grossSalary, dependents = 0, otherDeductions = 0, otherAdditions = 0) {
  const gross = parseFloat((grossSalary + otherAdditions).toFixed(2));
  const inss  = calculateINSS(gross);
  const irrf  = calculateIRRF(gross, inss, dependents);
  const fgts  = calculateFGTS(gross);
  const net   = parseFloat((gross - inss - irrf - otherDeductions).toFixed(2));
  return {
    gross_salary:     gross,
    inss_employee:    inss,
    irrf:             irrf,
    fgts:             fgts,
    other_deductions: parseFloat(otherDeductions.toFixed(2)),
    other_additions:  parseFloat(otherAdditions.toFixed(2)),
    net_salary:       Math.max(net, 0),
  };
}

module.exports = {
  calculateINSS, calculateIRRF, calculateFGTS, calculatePayroll,
  INSS_BRACKETS_2026, IRRF_BRACKETS_2026, INSS_TETO_2026, INSS_MAX_2026, FGTS_RATE,
};
