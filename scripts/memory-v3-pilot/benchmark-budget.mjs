/**
 * Memory V3 Task 3A — configured worst-case budget gate.
 * Integer nanodollars (1e-9 USD). No network, filesystem, env, date, or random I/O.
 */

const OWN_ERRORS = new WeakSet();
const NANODOLLARS_PER_USD = 1_000_000_000n;
const MAX_DECIMAL_PLACES = 10;
const CONFIG_FIELDS = Object.freeze([
  'caseCount',
  'maxInputTokensPerCase',
  'maxOutputTokensPerCase',
  'inputUsdPerMillion',
  'outputUsdPerMillion',
  'maxRequests',
  'maxBudgetUsd',
]);

function fail(stage, message) {
  const error = new Error(`[memory-v3:budget-${stage}] ${message}`);
  error.name = 'MemoryV3BudgetError';
  OWN_ERRORS.add(error);
  return error;
}

function assertNonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw fail('config', `${label} must be a non-negative integer`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw fail('config', `${label} overflows`);
  }
}

function parseNonNegativeDecimal(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw fail('config', `${label} must be a finite non-negative number`);
  }
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw fail('config', `${label} has unsupported precision`);
  }
  const fraction = text.includes('.') ? text.split('.')[1] : '';
  if (fraction.length > MAX_DECIMAL_PLACES) {
    throw fail('config', `${label} has unsupported precision`);
  }
  const [whole, frac = ''] = text.split('.');
  const denom = 10n ** BigInt(frac.length);
  const numer = BigInt(whole) * denom + BigInt(frac || '0');
  return { numer, denom };
}

function multiplyChecked(left, right, label) {
  const product = left * right;
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw fail('config', `${label} overflows`);
  }
  return product;
}

function tokensCostNano(tokens, price) {
  return {
    numer: tokens * price.numer * 1000n,
    denom: price.denom,
  };
}

function reduceFraction(fraction) {
  const gcd = (left, right) => (right === 0n ? left : gcd(right, left % right));
  const divisor = gcd(fraction.numer, fraction.denom);
  return {
    numer: fraction.numer / divisor,
    denom: fraction.denom / divisor,
  };
}

function addNanoFractions(left, right) {
  return reduceFraction({
    numer: left.numer * right.denom + right.numer * left.denom,
    denom: left.denom * right.denom,
  });
}

function compareNanoToUsd(costNano, budgetUsd) {
  const budgetNano = {
    numer: budgetUsd.numer * NANODOLLARS_PER_USD,
    denom: budgetUsd.denom,
  };
  const left = costNano.numer * budgetNano.denom;
  const right = budgetNano.numer * costNano.denom;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nanoFromFraction(fraction) {
  if (fraction.numer % fraction.denom !== 0n) return null;
  return fraction.numer / fraction.denom;
}

function formatUsdFromNano(nano) {
  if (nano === 0n) return '0';
  const whole = nano / NANODOLLARS_PER_USD;
  const frac = (nano % NANODOLLARS_PER_USD)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return frac.length === 0 ? `${whole}` : `${whole}.${frac}`;
}

function isOwnError(error) {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    OWN_ERRORS.has(error)
  );
}

function inspectConfig(config) {
  let proto;
  try {
    proto = Object.getPrototypeOf(config);
  } catch {
    throw fail('config', 'config must be a plain object');
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw fail('config', 'config must be a plain object');
  }
  if (proto !== Object.prototype && proto !== null) {
    throw fail('config', 'config must be a plain object');
  }

  let keys;
  try {
    keys = Reflect.ownKeys(config);
  } catch {
    throw fail('config', 'config has an invalid shape');
  }

  const allowed = new Set(CONFIG_FIELDS);
  const copy = {};
  for (const key of keys) {
    if (typeof key === 'symbol' || !allowed.has(key)) {
      throw fail('config', 'config has an unknown field');
    }
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(config, key);
    } catch {
      throw fail('config', 'config has an invalid shape');
    }
    if (
      !desc ||
      typeof desc.get === 'function' ||
      typeof desc.set === 'function' ||
      !Object.prototype.hasOwnProperty.call(desc, 'value') ||
      desc.enumerable !== true
    ) {
      throw fail('config', 'config has an invalid field');
    }
    if (desc.value === undefined) {
      throw fail('config', 'config is missing a required field');
    }
    copy[key] = desc.value;
  }
  for (const field of CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(copy, field)) {
      throw fail('config', 'config is missing a required field');
    }
  }
  return copy;
}

export function calculateBudgetCeiling(config) {
  try {
    return calculateBudgetCeilingInner(config);
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw fail('config', 'config has an invalid shape');
  }
}

function calculateBudgetCeilingInner(config) {
  const inspected = inspectConfig(config);
  assertNonNegativeInteger(inspected.caseCount, 'caseCount');
  assertNonNegativeInteger(inspected.maxInputTokensPerCase, 'maxInputTokensPerCase');
  assertNonNegativeInteger(inspected.maxOutputTokensPerCase, 'maxOutputTokensPerCase');
  assertNonNegativeInteger(inspected.maxRequests, 'maxRequests');

  const inputPrice = parseNonNegativeDecimal(inspected.inputUsdPerMillion, 'inputUsdPerMillion');
  const outputPrice = parseNonNegativeDecimal(inspected.outputUsdPerMillion, 'outputUsdPerMillion');
  const budget = parseNonNegativeDecimal(inspected.maxBudgetUsd, 'maxBudgetUsd');

  const caseCount = BigInt(inspected.caseCount);
  const absoluteMaxRequests = inspected.caseCount;
  const absoluteInputTokens = Number(
    multiplyChecked(caseCount, BigInt(inspected.maxInputTokensPerCase), 'absoluteInputTokens'),
  );
  const absoluteOutputTokens = Number(
    multiplyChecked(caseCount, BigInt(inspected.maxOutputTokensPerCase), 'absoluteOutputTokens'),
  );

  const inputCost = tokensCostNano(BigInt(absoluteInputTokens), inputPrice);
  const outputCost = tokensCostNano(BigInt(absoluteOutputTokens), outputPrice);
  const totalCost = addNanoFractions(inputCost, outputCost);
  const inputNano = nanoFromFraction(inputCost);
  const outputNano = nanoFromFraction(outputCost);
  const totalNano = nanoFromFraction(totalCost);
  if (inputNano === null || outputNano === null || totalNano === null) {
    throw fail('config', 'cost cannot be represented exactly');
  }
  const requestPass = absoluteMaxRequests <= inspected.maxRequests;
  const costPass = compareNanoToUsd(totalCost, budget) <= 0;

  return {
    caseCount: inspected.caseCount,
    absoluteMaxRequests,
    absoluteInputTokens,
    absoluteOutputTokens,
    inputCostUsd: formatUsdFromNano(inputNano),
    outputCostUsd: formatUsdFromNano(outputNano),
    absoluteCostUsd: formatUsdFromNano(totalNano),
    maxRequests: inspected.maxRequests,
    maxBudgetUsd: inspected.maxBudgetUsd,
    gate: requestPass && costPass ? 'PASS' : 'FAIL',
    costUnit: 'nanodollars',
    absoluteCostNanodollars: totalNano.toString(),
  };
}

export function assertBudgetGate(config) {
  const report = calculateBudgetCeiling(config);
  if (report.gate !== 'PASS') {
    throw fail('gate', 'configured worst-case budget was exceeded');
  }
  return report;
}
