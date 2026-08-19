/**
 * Memory V3 Task 3A — preflight budget tests.
 * Pure arithmetic. No network, filesystem, env, or dates at runtime.
 * Pricing snapshot is dated test data, not a live quote.
 * Run: node --test scripts/memory-v3-pilot/benchmark-budget.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertBudgetGate, calculateBudgetCeiling } from './benchmark-budget.mjs';

const PRICING_SNAPSHOT = Object.freeze({
  observedAt: '2026-08-19',
  model: 'openai/gpt-5.6-luna',
  inputUsdPerMillion: 0.2,
  outputUsdPerMillion: 1.2,
});

const FULL_SET = Object.freeze({
  caseCount: 24,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: PRICING_SNAPSHOT.inputUsdPerMillion,
  outputUsdPerMillion: PRICING_SNAPSHOT.outputUsdPerMillion,
  maxRequests: 24,
  maxBudgetUsd: 0.1132032,
});

const SIX_CASES = Object.freeze({
  caseCount: 6,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: PRICING_SNAPSHOT.inputUsdPerMillion,
  outputUsdPerMillion: PRICING_SNAPSHOT.outputUsdPerMillion,
  maxRequests: 6,
  maxBudgetUsd: 0.0283008,
});

const ONE_CASE = Object.freeze({
  caseCount: 1,
  maxInputTokensPerCase: 16384,
  maxOutputTokensPerCase: 1200,
  inputUsdPerMillion: PRICING_SNAPSHOT.inputUsdPerMillion,
  outputUsdPerMillion: PRICING_SNAPSHOT.outputUsdPerMillion,
  maxRequests: 1,
  maxBudgetUsd: 0.005,
});

describe('calculateBudgetCeiling dated pricing snapshot 2026-08-19', () => {
  it('passes the 24-case conservative ceiling at the exact total', () => {
    const report = calculateBudgetCeiling(FULL_SET);
    assert.equal(PRICING_SNAPSHOT.observedAt, '2026-08-19');
    assert.equal(PRICING_SNAPSHOT.model, 'openai/gpt-5.6-luna');
    assert.equal(PRICING_SNAPSHOT.inputUsdPerMillion, 0.2);
    assert.equal(PRICING_SNAPSHOT.outputUsdPerMillion, 1.2);
    assert.equal(report.absoluteMaxRequests, 24);
    assert.equal(report.absoluteInputTokens, 393216);
    assert.equal(report.absoluteOutputTokens, 28800);
    assert.equal(report.inputCostUsd, '0.0786432');
    assert.equal(report.outputCostUsd, '0.03456');
    assert.equal(report.absoluteCostUsd, '0.1132032');
    assert.equal(report.gate, 'PASS');
    assert.equal(report.costUnit, 'nanodollars');
    assert.equal(report.absoluteCostNanodollars, '113203200');
    assert.doesNotThrow(() => assertBudgetGate(FULL_SET));
  });

  it('passes the 6-case conservative ceiling at the exact total', () => {
    const report = calculateBudgetCeiling(SIX_CASES);
    assert.equal(report.absoluteMaxRequests, 6);
    assert.equal(report.absoluteInputTokens, 98304);
    assert.equal(report.absoluteOutputTokens, 7200);
    assert.equal(report.inputCostUsd, '0.0196608');
    assert.equal(report.outputCostUsd, '0.00864');
    assert.equal(report.absoluteCostUsd, '0.0283008');
    assert.equal(report.gate, 'PASS');
    assert.doesNotThrow(() => assertBudgetGate(SIX_CASES));
  });

  it('passes the one-case smoke ceiling under $0.005', () => {
    const report = calculateBudgetCeiling(ONE_CASE);
    assert.equal(report.absoluteMaxRequests, 1);
    assert.equal(report.absoluteInputTokens, 16384);
    assert.equal(report.absoluteOutputTokens, 1200);
    assert.equal(report.inputCostUsd, '0.0032768');
    assert.equal(report.outputCostUsd, '0.00144');
    assert.equal(report.absoluteCostUsd, '0.0047168');
    assert.equal(report.maxBudgetUsd, 0.005);
    assert.equal(report.gate, 'PASS');
    assert.doesNotThrow(() => assertBudgetGate(ONE_CASE));
  });

  it('fails the 24-case set one nanodollar-display unit below the exact total', () => {
    const report = calculateBudgetCeiling({ ...FULL_SET, maxBudgetUsd: 0.1132031 });
    assert.equal(report.absoluteCostUsd, '0.1132032');
    assert.equal(report.gate, 'FAIL');
    assert.throws(() => assertBudgetGate({ ...FULL_SET, maxBudgetUsd: 0.1132031 }), /budget-gate/);
  });

  it('fails the 6-case set one nanodollar-display unit below the exact total', () => {
    const report = calculateBudgetCeiling({ ...SIX_CASES, maxBudgetUsd: 0.0283007 });
    assert.equal(report.absoluteCostUsd, '0.0283008');
    assert.equal(report.gate, 'FAIL');
    assert.throws(() => assertBudgetGate({ ...SIX_CASES, maxBudgetUsd: 0.0283007 }), /budget-gate/);
  });

  it('fails the one-case smoke when budget is below the exact ceiling', () => {
    const report = calculateBudgetCeiling({ ...ONE_CASE, maxBudgetUsd: 0.0047167 });
    assert.equal(report.absoluteCostUsd, '0.0047168');
    assert.equal(report.gate, 'FAIL');
    assert.throws(() => assertBudgetGate({ ...ONE_CASE, maxBudgetUsd: 0.0047167 }), /budget-gate/);
  });

  it('fails when the request cap is below caseCount', () => {
    const report = calculateBudgetCeiling({ ...FULL_SET, maxRequests: 23 });
    assert.equal(report.gate, 'FAIL');
    assert.throws(() => assertBudgetGate({ ...FULL_SET, maxRequests: 23 }), /budget-gate/);
  });
});

describe('calculateBudgetCeiling invalid config', () => {
  it('rejects NaN, Infinity, negative, and fractional counts', () => {
    assert.throws(() => calculateBudgetCeiling({ ...FULL_SET, caseCount: Number.NaN }), /budget-config/);
    assert.throws(
      () => calculateBudgetCeiling({ ...FULL_SET, maxRequests: Number.POSITIVE_INFINITY }),
      /budget-config/,
    );
    assert.throws(
      () => calculateBudgetCeiling({ ...FULL_SET, maxInputTokensPerCase: -1 }),
      /budget-config/,
    );
    assert.throws(
      () => calculateBudgetCeiling({ ...FULL_SET, maxOutputTokensPerCase: 1.5 }),
      /budget-config/,
    );
    assert.throws(
      () => calculateBudgetCeiling({ ...FULL_SET, inputUsdPerMillion: -0.1 }),
      /budget-config/,
    );
  });

  it('rejects unsafe integer overflow', () => {
    assert.throws(
      () =>
        calculateBudgetCeiling({
          ...FULL_SET,
          caseCount: Number.MAX_SAFE_INTEGER,
          maxInputTokensPerCase: 4096,
        }),
      /budget-config|overflow/,
    );
  });

  it('rejects prices with unsupported precision', () => {
    assert.throws(
      () =>
        calculateBudgetCeiling({
          ...FULL_SET,
          inputUsdPerMillion: 0.1234567890123,
        }),
      /budget-config|precision/,
    );
  });

  it('treats zero caseCount as a zero-cost PASS when caps allow it', () => {
    const report = calculateBudgetCeiling({
      ...FULL_SET,
      caseCount: 0,
      maxRequests: 0,
      maxBudgetUsd: 0,
    });
    assert.equal(report.absoluteMaxRequests, 0);
    assert.equal(report.absoluteInputTokens, 0);
    assert.equal(report.absoluteOutputTokens, 0);
    assert.equal(report.absoluteCostUsd, '0');
    assert.equal(report.gate, 'PASS');
  });

  it('does not execute config getters and does not leak inspection sentinels', () => {
    const snapshot = structuredClone(FULL_SET);
    let getterCalls = 0;
    const config = { ...FULL_SET };
    Object.defineProperty(config, 'caseCount', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error('RAW_BUDGET_GETTER_SENTINEL');
      },
    });
    assert.throws(
      () => calculateBudgetCeiling(config),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:budget-config\]/);
        assert.equal(String(error.message).includes('RAW_BUDGET_GETTER_SENTINEL'), false);
        assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('RAW_BUDGET_GETTER_SENTINEL'), false);
        assert.equal(error.cause == null, true);
        return true;
      },
    );
    assert.equal(getterCalls, 0);

    const spoofed = new Proxy(
      { ...FULL_SET },
      {
        getPrototypeOf() {
          const error = new Error('RAW_BUDGET_GETTER_SENTINEL');
          error.name = 'MemoryV3BudgetError';
          throw error;
        },
      },
    );
    assert.throws(
      () => calculateBudgetCeiling(spoofed),
      (error) => {
        assert.match(String(error.message), /^\[memory-v3:budget-config\]/);
        assert.equal(String(error.message).includes('RAW_BUDGET_GETTER_SENTINEL'), false);
        assert.equal(error.cause == null, true);
        return true;
      },
    );

    const withSymbol = { ...FULL_SET };
    withSymbol[Symbol('hidden')] = 'RAW_BUDGET_GETTER_SENTINEL';
    assert.throws(() => calculateBudgetCeiling(withSymbol), /budget-config/);

    const hidden = { ...FULL_SET };
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: 'RAW_BUDGET_GETTER_SENTINEL',
    });
    assert.throws(() => calculateBudgetCeiling(hidden), /budget-config/);

    const original = { ...FULL_SET };
    const originalSnapshot = structuredClone(original);
    calculateBudgetCeiling(original);
    assert.deepEqual(original, originalSnapshot);
    assert.deepEqual(FULL_SET, snapshot);
  });
});
