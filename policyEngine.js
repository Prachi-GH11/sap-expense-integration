const rules = require('../data/policy-rules.json');

function jobGradeNumber(grade) {
  // "M3" -> 3, "M6" -> 6
  const match = String(grade).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function gradeBand(gradeNum) {
  if (gradeNum <= 3) return 'low';
  if (gradeNum <= 5) return 'mid';
  return 'high';
}

/**
 * Evaluates one expense line against policy rules using employee context
 * pulled from HCM. Returns a decision the approval router and auto-coder
 * both depend on.
 */
function evaluateExpense(expense, employee) {
  const violations = [];
  const gradeNum = jobGradeNumber(employee.JobGrade);

  const rule = rules.eligibilityRules.find((r) => r.category === expense.category);
  if (rule) {
    if (rule.category === 'Airfare - international' && expense.fareClass === 'business') {
      if (gradeNum < rule.eligibility.minJobGradeNumber) {
        violations.push({ ruleId: rule.ruleId, severity: rule.onViolation.severity, message: rule.onViolation.message });
      }
    }
    if (rule.category === 'Hotel') {
      const band = gradeBand(gradeNum);
      const cap = rule.eligibility.maxNightlyRateByGrade[band];
      if (expense.amount > cap) {
        violations.push({ ruleId: rule.ruleId, severity: rule.onViolation.severity, message: rule.onViolation.message });
      }
    }
    if (rule.category === 'Client meal') {
      const perHead = expense.attendeeCount ? expense.amount / expense.attendeeCount : expense.amount;
      if (perHead > rule.eligibility.maxPerHead) {
        violations.push({ ruleId: rule.ruleId, severity: rule.onViolation.severity, message: rule.onViolation.message });
      }
    }
  }

  const hasBlock = violations.some((v) => v.severity === 'block');
  const status = hasBlock ? 'blocked' : violations.length ? 'flagged' : 'compliant';

  return { status, violations };
}

/**
 * Calculates per diem for a trip. Called at trip creation AND re-called any
 * time startDate, endDate, or destination changes — this is the fix for the
 * "per diem not recalculated on date change" gap. Callers should compare the
 * returned total against the previous stored total and surface the delta to
 * the employee rather than silently changing the number.
 */
function calculatePerDiem({ country, startDate, endDate, mealsIncluded = {} }) {
  const rate = rules.perDiemRates.find((r) => r.country === country);
  if (!rate) {
    return { error: `No per diem rate configured for country '${country}'` };
  }

  const days = Math.max(1, Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000));
  let dailyRate = rate.dailyMax;

  for (const meal of Object.keys(mealsIncluded)) {
    if (mealsIncluded[meal] && rate.mealsIncludedDeduction[meal]) {
      dailyRate -= rate.dailyMax * rate.mealsIncludedDeduction[meal];
    }
  }

  return {
    country: rate.countryName,
    currency: rate.currency,
    days,
    dailyRate: Math.round(dailyRate * 100) / 100,
    totalPerDiem: Math.round(dailyRate * days * 100) / 100,
  };
}

/**
 * Recalculation trigger: compares a newly computed per-diem total against
 * the previously stored one for the same trip and returns whether the
 * change should be flagged to the employee.
 */
function recalculatePerDiem(previousTotal, tripInput) {
  const updated = calculatePerDiem(tripInput);
  if (updated.error) return updated;
  const changed = previousTotal !== undefined && previousTotal !== updated.totalPerDiem;
  return { ...updated, changed, previousTotal: previousTotal ?? null };
}

module.exports = { evaluateExpense, calculatePerDiem, recalculatePerDiem };
