/**
 * KemdiCode MCP Server - Monitoring & Metrics System
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Monitoring & Metrics System
 *
 * Features:
 * - Counter, Gauge, Histogram metrics
 * - Automatic health checks
 * - Alerting system
 * - Performance tracking
 * - Export for monitoring systems
 *
 * @module utils/metrics
 */

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'timer';

export interface Metric {
  name: string;
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface CounterMetric {
  increment(delta?: number): void;
  reset(): void;
  getValue(): number;
}

export interface GaugeMetric {
  set(value: number): void;
  increment(delta?: number): void;
  decrement(delta?: number): void;
  getValue(): number;
}

export interface HistogramMetric {
  observe(value: number): void;
  getPercentiles(percentiles: number[]): Map<number, number>;
  getCount(): number;
  getSum(): number;
}

export interface TimerMetric {
  start(): () => number;
  observe(duration: number): void;
  getPercentiles(percentiles: number[]): Map<number, number>;
}

export interface MetricsConfig {
  enabled?: boolean;
  prefix?: string;
  defaultLabels?: Record<string, string>;
  exportInterval?: number;
}

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  lastCheck: number;
  duration: number;
}

export interface AlertRule {
  name: string;
  condition: (metrics: MetricsRegistry) => boolean;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  fired: boolean;
  lastFired?: number;
}

export interface MetricsRegistry {
  counter(name: string, labels?: Record<string, string>): CounterMetric;
  gauge(name: string, labels?: Record<string, string>): GaugeMetric;
  histogram(name: string, buckets?: number[], labels?: Record<string, string>): HistogramMetric;
  timer(name: string, labels?: Record<string, string>): TimerMetric;
  getMetrics(): Metric[];
  getHealthChecks(): HealthCheck[];
  reset(): void;
  stopHealthChecks(): void;
}

class CounterImpl implements CounterMetric {
  private value = 0;
  private labels: Record<string, string>;

  constructor(labels: Record<string, string> = {}) {
    this.labels = { ...labels };
  }

  increment(delta = 1): void {
    this.value += delta;
  }

  reset(): void {
    this.value = 0;
  }

  getValue(): number {
    return this.value;
  }
}

class GaugeImpl implements GaugeMetric {
  private value = 0;
  private labels: Record<string, string>;

  constructor(labels: Record<string, string> = {}) {
    this.labels = { ...labels };
  }

  set(value: number): void {
    this.value = value;
  }

  increment(delta = 1): void {
    this.value += delta;
  }

  decrement(delta = 1): void {
    this.value -= delta;
  }

  getValue(): number {
    return this.value;
  }
}

class HistogramImpl implements HistogramMetric {
  private values: number[] = [];
  private sum = 0;
  private labels: Record<string, string>;
  private buckets: number[];

  constructor(buckets: number[] = [0.1, 0.5, 1, 2, 5, 10], labels: Record<string, string> = {}) {
    this.buckets = buckets;
    this.labels = { ...labels };
  }

  observe(value: number): void {
    this.values.push(value);
    this.sum += value;
  }

  getPercentiles(percentiles: number[]): Map<number, number> {
    const sorted = [...this.values].sort((a, b) => a - b);
    const result = new Map<number, number>();

    for (const p of percentiles) {
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      result.set(p, sorted[Math.max(0, idx)] || 0);
    }

    return result;
  }

  getCount(): number {
    return this.values.length;
  }

  getSum(): number {
    return this.sum;
  }
}

class TimerImpl implements TimerMetric {
  private histogram: HistogramImpl;

  constructor(labels: Record<string, string> = {}) {
    this.histogram = new HistogramImpl([1, 5, 10, 50, 100, 500, 1000], labels);
  }

  start(): () => number {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.observe(duration);
      return duration;
    };
  }

  observe(duration: number): void {
    this.histogram.observe(duration);
  }

  getPercentiles(percentiles: number[]): Map<number, number> {
    return this.histogram.getPercentiles(percentiles);
  }
}

export class MetricsRegistryImpl implements MetricsRegistry {
  private counters = new Map<string, CounterImpl>();
  private gauges = new Map<string, GaugeImpl>();
  private histograms = new Map<string, HistogramImpl>();
  private timers = new Map<string, TimerImpl>();
  private config: Required<MetricsConfig>;
  private healthChecks: Map<string, HealthCheck> = new Map();
  private healthCheckIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private alertRules: AlertRule[] = [];
  private startTime = Date.now();

  constructor(config: MetricsConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      prefix: config.prefix ?? 'mcp',
      defaultLabels: config.defaultLabels ?? {},
      exportInterval: config.exportInterval ?? 10000,
    };
  }

  counter(name: string, labels?: Record<string, string>): CounterMetric {
    const key = this.getKey(name, labels);
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new CounterImpl({ ...this.config.defaultLabels, ...labels });
      this.counters.set(key, counter);
    }
    return counter;
  }

  gauge(name: string, labels?: Record<string, string>): GaugeMetric {
    const key = this.getKey(name, labels);
    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = new GaugeImpl({ ...this.config.defaultLabels, ...labels });
      this.gauges.set(key, gauge);
    }
    return gauge;
  }

  histogram(name: string, buckets?: number[], labels?: Record<string, string>): HistogramMetric {
    const key = this.getKey(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new HistogramImpl(buckets, { ...this.config.defaultLabels, ...labels });
      this.histograms.set(key, histogram);
    }
    return histogram;
  }

  timer(name: string, labels?: Record<string, string>): TimerImpl {
    const key = this.getKey(name, labels);
    let timer = this.timers.get(key);
    if (!timer) {
      timer = new TimerImpl({ ...this.config.defaultLabels, ...labels });
      this.timers.set(key, timer);
    }
    return timer;
  }

  registerHealthCheck(name: string, check: () => Promise<HealthCheck>): void {
    // Clear existing interval if re-registering
    const existingInterval = this.healthCheckIntervals.get(name);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    const runCheck = async () => {
      const start = Date.now();
      try {
        const result = await check();
        result.duration = Date.now() - start;
        return result;
      } catch (error) {
        return {
          name,
          status: 'unhealthy' as const,
          message: String(error),
          lastCheck: Date.now(),
          duration: Date.now() - start,
        };
      }
    };

    this.healthChecks.set(name, {
      name,
      status: 'healthy',
      lastCheck: Date.now(),
      duration: 0,
    });

    const intervalId = setInterval(async () => {
      const result = await runCheck();
      this.healthChecks.set(name, result);
    }, this.config.exportInterval);

    this.healthCheckIntervals.set(name, intervalId);
  }

  /**
   * Stop all health check intervals
   */
  stopHealthChecks(): void {
    for (const intervalId of this.healthCheckIntervals.values()) {
      clearInterval(intervalId);
    }
    this.healthCheckIntervals.clear();
  }

  registerAlert(rule: AlertRule): void {
    this.alertRules.push(rule);
  }

  private getKey(name: string, labels?: Record<string, string>): string {
    const prefix = this.config.prefix ? `${this.config.prefix}_` : '';
    if (!labels || Object.keys(labels).length === 0) {
      return `${prefix}${name}`;
    }
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${prefix}${name}{${labelStr}}`;
  }

  getMetrics(): Metric[] {
    const metrics: Metric[] = [];
    const now = Date.now();

    for (const [key, counter] of this.counters) {
      metrics.push({
        name: key,
        type: 'counter',
        value: counter.getValue(),
        labels: {},
        timestamp: now,
      });
    }

    for (const [key, gauge] of this.gauges) {
      metrics.push({
        name: key,
        type: 'gauge',
        value: gauge.getValue(),
        labels: {},
        timestamp: now,
      });
    }

    for (const [key, histogram] of this.histograms) {
      metrics.push({
        name: key,
        type: 'histogram',
        value: histogram.getSum(),
        labels: { count: String(histogram.getCount()) },
        timestamp: now,
      });
    }

    for (const [key, timer] of this.timers) {
      metrics.push({
        name: key,
        type: 'timer',
        value: timer.getPercentiles([50, 90, 99]).get(50) || 0,
        labels: {},
        timestamp: now,
      });
    }

    metrics.push({
      name: `${this.config.prefix}_uptime_seconds`,
      type: 'gauge',
      value: (now - this.startTime) / 1000,
      labels: {},
      timestamp: now,
    });

    return metrics;
  }

  getHealthChecks(): HealthCheck[] {
    return [...this.healthChecks.values()];
  }

  reset(): void {
    this.stopHealthChecks();
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.timers.clear();
    this.startTime = Date.now();
  }

  getStats(): {
    counters: number;
    gauges: number;
    histograms: number;
    timers: number;
    healthChecks: number;
    uptime: number;
  } {
    return {
      counters: this.counters.size,
      gauges: this.gauges.size,
      histograms: this.histograms.size,
      timers: this.timers.size,
      healthChecks: this.healthChecks.size,
      uptime: Date.now() - this.startTime,
    };
  }
}

export const metrics = new MetricsRegistryImpl({
  prefix: 'kemdicode',
  enabled: true,
});

export function createMetrics(config?: MetricsConfig): MetricsRegistryImpl {
  return new MetricsRegistryImpl(config);
}
