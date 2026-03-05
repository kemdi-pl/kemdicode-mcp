/**
 * Pass Controller — Unit Tests
 *
 * Tests for multi-pass self-regulating LLM execution:
 * - Assessment skip heuristics
 * - Task budget detection
 * - Quality extraction
 * - Strategy behavior (min-passes, quality-target, fixed)
 *
 * Self-contained: tests pure logic, mocks AI client for LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll dynamically import to allow mocking
let PassController: typeof import('../../../src/cluster-bus/pass-controller.js').PassController;
let shouldSkipAssessment: typeof import('../../../src/cluster-bus/pass-controller.js').shouldSkipAssessment;
let detectTaskBudget: typeof import('../../../src/cluster-bus/pass-controller.js').detectTaskBudget;

// Mock AI client to avoid real LLM calls
vi.mock('../../../src/ai/client.js', () => ({
  complete: vi.fn().mockResolvedValue({
    content: '{"minPasses": 2, "reasoning": "moderate complexity", "complexity": "moderate"}',
    usage: { promptTokens: 100, completionTokens: 50 },
  }),
}));

// Mock logger to suppress noise
vi.mock('../../../src/utils/logger.js', () => ({
  Logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../../../src/cluster-bus/pass-controller.js');
  PassController = mod.PassController;
  shouldSkipAssessment = mod.shouldSkipAssessment;
  detectTaskBudget = mod.detectTaskBudget;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// shouldSkipAssessment
// ---------------------------------------------------------------------------

describe('shouldSkipAssessment', () => {
  it('should skip short text without code', () => {
    expect(shouldSkipAssessment('What is AI?')).toBe(true);
    expect(shouldSkipAssessment('Explain quantum computing')).toBe(true);
  });

  it('should not skip text with code blocks', () => {
    expect(shouldSkipAssessment('Fix this:\n```ts\nconst x = 1;\n```')).toBe(false);
  });

  it('should not skip long text', () => {
    const longText = 'A '.repeat(200);
    expect(shouldSkipAssessment(longText)).toBe(false);
  });

  it('should skip short prompts with few words', () => {
    expect(shouldSkipAssessment('hello world')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectTaskBudget
// ---------------------------------------------------------------------------

describe('detectTaskBudget', () => {
  it('should detect "explain" tasks → budget 1', () => {
    const r = detectTaskBudget('Explain how photosynthesis works');
    expect(r.type).toBe('explain');
    expect(r.budget).toBe(1);
  });

  it('should detect "fix" tasks → budget 2', () => {
    const r = detectTaskBudget('Fix the bug in login handler');
    expect(r.type).toBe('fix');
    expect(r.budget).toBe(2);
  });

  it('should detect "review" tasks → budget 3', () => {
    const r = detectTaskBudget('Review this pull request for issues');
    expect(r.type).toBe('review');
    expect(r.budget).toBe(3);
  });

  it('should detect "refactor" tasks → budget 3', () => {
    const r = detectTaskBudget('Refactor the authentication module');
    expect(r.type).toBe('refactor');
    expect(r.budget).toBe(3);
  });

  it('should detect "generate/create/build" tasks → budget 4', () => {
    expect(detectTaskBudget('Generate unit tests for UserService').type).toBe('generate');
    expect(detectTaskBudget('Create a REST API endpoint').type).toBe('generate');
    expect(detectTaskBudget('Build a React component').type).toBe('generate');
  });

  it('should detect "design/architect" tasks → budget 4', () => {
    const r = detectTaskBudget('Design a microservice architecture');
    expect(r.type).toBe('design');
    expect(r.budget).toBe(4);
  });

  it('should default to "general" → budget 2', () => {
    const r = detectTaskBudget('Do something unspecified');
    expect(r.type).toBe('general');
    expect(r.budget).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PassController — fixed strategy
// ---------------------------------------------------------------------------

describe('PassController — fixed strategy', () => {
  it('should declare exact N passes without LLM assessment', async () => {
    const ctrl = new PassController({ strategy: 'fixed', maxPasses: 3 });
    const assessment = await ctrl.assess('any prompt');

    expect(assessment.minPasses).toBe(3);
    expect(assessment.reasoning).toBe('Fixed strategy');
  });

  it('shouldContinue returns true until all passes done', () => {
    const ctrl = new PassController({ strategy: 'fixed', maxPasses: 2 });

    // Simulate pass history
    (ctrl as any).history.push({
      pass: 1, content: 'r1', quality: 0.9, sufficient: true, tokensUsed: 100, latencyMs: 500,
    });
    expect(ctrl.shouldContinue()).toBe(true);

    (ctrl as any).history.push({
      pass: 2, content: 'r2', quality: 0.95, sufficient: true, tokensUsed: 120, latencyMs: 600,
    });
    expect(ctrl.shouldContinue()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PassController — report & metrics
// ---------------------------------------------------------------------------

describe('PassController — report & metrics', () => {
  it('should calculate total tokens and latency', () => {
    const ctrl = new PassController({ strategy: 'fixed', maxPasses: 2 });
    (ctrl as any).history = [
      { pass: 0, content: 'assess', quality: 0, sufficient: false, tokensUsed: 50, latencyMs: 200 },
      { pass: 1, content: 'r1', quality: 0.7, sufficient: false, tokensUsed: 100, latencyMs: 500 },
      { pass: 2, content: 'r2', quality: 0.9, sufficient: true, tokensUsed: 120, latencyMs: 600 },
    ];

    expect(ctrl.getTotalTokens()).toBe(270);
    expect(ctrl.getTotalLatency()).toBe(1300);
  });

  it('should return final content from last pass', () => {
    const ctrl = new PassController({ strategy: 'fixed', maxPasses: 2 });
    (ctrl as any).history = [
      { pass: 0, content: 'assess', quality: 0, sufficient: false, tokensUsed: 50, latencyMs: 200 },
      { pass: 1, content: 'first', quality: 0.7, sufficient: false, tokensUsed: 100, latencyMs: 500 },
      { pass: 2, content: 'final', quality: 0.9, sufficient: true, tokensUsed: 120, latencyMs: 600 },
    ];

    expect(ctrl.getFinalContent()).toBe('final');
  });

  it('should generate correct report', () => {
    const ctrl = new PassController({ strategy: 'quality-target', maxPasses: 3, qualityThreshold: 0.8 });
    (ctrl as any).minPassesDeclared = 2;
    (ctrl as any).history = [
      { pass: 1, content: 'r1', quality: 0.85, sufficient: true, tokensUsed: 100, latencyMs: 500 },
    ];

    const report = ctrl.getReport();
    expect(report.totalPasses).toBe(1);
    expect(report.minPassesDeclared).toBe(2);
    expect(report.qualityAchieved).toBe(0.85);
    expect(report.passHistory).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PassController — quality-target early stop
// ---------------------------------------------------------------------------

describe('PassController — quality-target', () => {
  it('should stop when quality meets threshold', () => {
    const ctrl = new PassController({ strategy: 'quality-target', maxPasses: 5, qualityThreshold: 0.8 });

    (ctrl as any).history.push({
      pass: 1, content: 'r1', quality: 0.85, sufficient: true, tokensUsed: 100, latencyMs: 500,
    });

    expect(ctrl.shouldContinue()).toBe(false);
  });

  it('should continue when quality is below threshold', () => {
    const ctrl = new PassController({ strategy: 'quality-target', maxPasses: 5, qualityThreshold: 0.8 });

    (ctrl as any).history.push({
      pass: 1, content: 'r1', quality: 0.5, sufficient: false, tokensUsed: 100, latencyMs: 500,
    });

    expect(ctrl.shouldContinue()).toBe(true);
  });

  it('should stop when quality delta is diminishing', () => {
    const ctrl = new PassController({ strategy: 'quality-target', maxPasses: 5, qualityThreshold: 0.9 });

    (ctrl as any).history.push(
      { pass: 1, content: 'r1', quality: 0.5, sufficient: false, tokensUsed: 100, latencyMs: 500 },
      { pass: 2, content: 'r2', quality: 0.51, sufficient: false, tokensUsed: 110, latencyMs: 550 },
    );

    // Delta = 0.01, gap to 0.9 = 0.39 -> should stop (diminishing returns)
    expect(ctrl.shouldContinue()).toBe(false);
  });

  it('should stop when quality decreases', () => {
    const ctrl = new PassController({ strategy: 'quality-target', maxPasses: 5, qualityThreshold: 0.9 });

    (ctrl as any).history.push(
      { pass: 1, content: 'r1', quality: 0.7, sufficient: false, tokensUsed: 100, latencyMs: 500 },
      { pass: 2, content: 'r2', quality: 0.6, sufficient: false, tokensUsed: 110, latencyMs: 550 },
    );

    expect(ctrl.shouldContinue()).toBe(false);
  });
});
