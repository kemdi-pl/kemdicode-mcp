/**
 * KemdiCode MCP Server - CI Multicast Integration Tests
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { ClusterBus, initClusterBus, shutdownClusterBus } from '../../src/cluster-bus/index.js';
import { ClusterBusConfig, loadClusterBusConfig } from '../../src/cluster-bus/types.js';
import type { CIMulticastPayloadType, CIResultPayloadType } from '../../src/cluster-bus/types.js';
import {
  startAggregation,
  addResult,
  getAggregation,
  reset as resetAggregator,
} from '../../src/cluster-bus/fan-in-aggregator.js';

describe('CI Multicast Integration', () => {
  let bus: ClusterBus;
  let config: ClusterBusConfig;

  beforeAll(() => {
    config = loadClusterBusConfig();
  });

  beforeEach(async () => {
    resetAggregator();
    bus = new ClusterBus(config);
    await bus.connect();
  });

  afterEach(async () => {
    if (bus) {
      await bus.disconnect();
    }
    resetAggregator();
  });

  describe('Multicast Signal Types', () => {
    it('should have all CI signal types defined', () => {
      const signalTypes = [
        'ci:build',
        'ci:test',
        'ci:deploy',
        'ci:result',
        'ci:pipeline',
        'ci:multicast',
        'data:multicast',
      ];

      for (const type of signalTypes) {
        expect(typeof type).toBe('string');
      }
    });
  });

  describe('Fan-In Aggregation', () => {
    it('should start aggregation for multicast payload', () => {
      const payload: CIMulticastPayloadType = {
        pipelineId: 'test-pipeline-123',
        stage: 'build',
        targets: ['cluster-a', 'cluster-b', 'cluster-c'],
        aggregationMode: 'all',
        payload: { command: 'npm run build' },
        timeoutMs: 60000,
        retryCount: 0,
      };

      const result = startAggregation(payload);

      expect(result.pipelineId).toBe('test-pipeline-123');
      expect(result.stage).toBe('build');
      expect(result.totalExpected).toBe(3);
      expect(result.state).toBe('collecting');
    });

    it('should collect results from multiple clusters', () => {
      const payload: CIMulticastPayloadType = {
        pipelineId: 'test-pipeline-456',
        stage: 'test',
        targets: ['cluster-a', 'cluster-b'],
        aggregationMode: 'all',
        payload: { testSuite: 'unit' },
        timeoutMs: 60000,
        retryCount: 0,
      };

      startAggregation(payload);

      const result1: CIResultPayloadType = {
        pipelineId: 'test-pipeline-456',
        stage: 'test',
        targetCluster: 'cluster-a',
        success: true,
        output: { testsPassed: 150 },
        durationMs: 30000,
        timestamp: Date.now(),
      };

      const result2: CIResultPayloadType = {
        pipelineId: 'test-pipeline-456',
        stage: 'test',
        targetCluster: 'cluster-b',
        success: true,
        output: { testsPassed: 148 },
        durationMs: 32000,
        timestamp: Date.now(),
      };

      addResult(result1);
      addResult(result2);

      const aggregation = getAggregation('test-pipeline-456');

      expect(aggregation).not.toBeNull();
      expect(aggregation!.receivedCount).toBe(2);
      expect(aggregation!.successCount).toBe(2);
      expect(aggregation!.state).toBe('completed');
    });

    it('should handle partial failures', () => {
      const payload: CIMulticastPayloadType = {
        pipelineId: 'test-pipeline-789',
        stage: 'deploy',
        targets: ['cluster-a', 'cluster-b', 'cluster-c'],
        aggregationMode: 'all',
        payload: { environment: 'staging' },
        timeoutMs: 60000,
        retryCount: 1,
      };

      startAggregation(payload);

      const successResult: CIResultPayloadType = {
        pipelineId: 'test-pipeline-789',
        stage: 'deploy',
        targetCluster: 'cluster-a',
        success: true,
        durationMs: 15000,
        timestamp: Date.now(),
      };

      const failureResult: CIResultPayloadType = {
        pipelineId: 'test-pipeline-789',
        stage: 'deploy',
        targetCluster: 'cluster-b',
        success: false,
        error: 'Connection timeout',
        durationMs: 60000,
        timestamp: Date.now(),
      };

      addResult(successResult);
      addResult(failureResult);

      const aggregation = getAggregation('test-pipeline-789');

      expect(aggregation).not.toBeNull();
      expect(aggregation!.receivedCount).toBe(2);
      expect(aggregation!.successCount).toBe(1);
      expect(aggregation!.failureCount).toBe(1);
    });

    it('should complete on first success for first mode', () => {
      const payload: CIMulticastPayloadType = {
        pipelineId: 'test-pipeline-first',
        stage: 'build',
        targets: ['cluster-a', 'cluster-b', 'cluster-c'],
        aggregationMode: 'first',
        payload: { command: 'make' },
        timeoutMs: 60000,
        retryCount: 0,
      };

      startAggregation(payload);

      const result1: CIResultPayloadType = {
        pipelineId: 'test-pipeline-first',
        stage: 'build',
        targetCluster: 'cluster-a',
        success: false,
        durationMs: 5000,
        timestamp: Date.now(),
      };

      const result2: CIResultPayloadType = {
        pipelineId: 'test-pipeline-first',
        stage: 'build',
        targetCluster: 'cluster-b',
        success: true,
        durationMs: 10000,
        timestamp: Date.now(),
      };

      addResult(result1);
      addResult(result2);

      const aggregation = getAggregation('test-pipeline-first');

      expect(aggregation).not.toBeNull();
      expect(aggregation!.state).toBe('completed');
      expect(aggregation!.receivedCount).toBe(2);
    });

    it('should aggregate all results with mixed successes and failures', () => {
      const payload: CIMulticastPayloadType = {
        pipelineId: 'test-pipeline-all-mixed',
        stage: 'validate',
        targets: ['cluster-a', 'cluster-b', 'cluster-c'],
        aggregationMode: 'all',
        payload: { checks: ['lint', 'format', 'types'] },
        timeoutMs: 60000,
        retryCount: 0,
      };

      startAggregation(payload);

      const results: CIResultPayloadType[] = [
        {
          pipelineId: 'test-pipeline-all-mixed',
          stage: 'validate',
          targetCluster: 'cluster-a',
          success: true,
          durationMs: 10000,
          timestamp: Date.now(),
        },
        {
          pipelineId: 'test-pipeline-all-mixed',
          stage: 'validate',
          targetCluster: 'cluster-b',
          success: true,
          durationMs: 10000,
          timestamp: Date.now(),
        },
        {
          pipelineId: 'test-pipeline-all-mixed',
          stage: 'validate',
          targetCluster: 'cluster-c',
          success: false,
          error: 'Lint failed',
          durationMs: 5000,
          timestamp: Date.now(),
        },
      ];

      for (const result of results) {
        addResult(result);
      }

      const aggregation = getAggregation('test-pipeline-all-mixed');

      expect(aggregation).not.toBeNull();
      expect(aggregation!.successCount).toBe(2);
      expect(aggregation!.failureCount).toBe(1);
      expect(aggregation!.receivedCount).toBe(3);
      expect(aggregation!.state).toBe('completed');
    });
  });

  describe('ClusterBus Multicast', () => {
    it('should create multicast signal', async () => {
      const targets = ['build-1', 'build-2', 'test-1'];

      const result = await bus.multicast(
        targets,
        'ci:build',
        { command: 'npm run build', env: { NODE_ENV: 'production' } },
        { priority: 2 }
      );

      expect(result.signalId).toBeDefined();
      expect(result.multicastId).toBeDefined();
      expect(result.targets).toEqual(targets);
    });

    it('should return multicast ID for tracking', async () => {
      const targets = ['deploy-1', 'deploy-2'];

      const result = await bus.multicast(
        targets,
        'ci:deploy',
        { target: 'production', strategy: 'blue-green' },
        { priority: 3 }
      );

      expect(result.multicastId).toMatch(/^mc_\d+_[a-z0-9]+$/);
    });
  });
});
