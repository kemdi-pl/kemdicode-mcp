/**
 * KemdiCode MCP Server - Worker Thread Pool
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
 * Worker Thread Pool for Parallel Tool Execution
 *
 * Features:
 * - Configurable pool size based on CPU cores
 * - Priority queue for urgent tasks
 * - Automatic retry on worker failure
 * - Graceful shutdown with pending work completion
 *
 * @module infrastructure/worker-pool
 */

import { Worker } from 'node:worker_threads';
import { Logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface PoolConfig {
  size?: number;
  maxPending?: number;
  timeout?: number;
}

interface InternalTask {
  id: string;
  data: unknown;
  priority: number;
  createdAt: number;
  timeout?: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerTaskMessage {
  type: 'task';
  taskId: string;
  data: unknown;
  timeout?: number;
}

interface WorkerResultMessage {
  type: 'result';
  taskId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface WorkerStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeWorkers: number;
  pendingTasks: number;
  avgTaskDuration: number;
}

class WorkerPool {
  private workers: Worker[] = [];
  private taskQueue: InternalTask[] = [];
  private activeTasks = new Map<string, InternalTask>();
  private workerTaskMap = new Map<Worker, string>();
  private config: Required<PoolConfig>;
  private stats = {
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    taskDurations: [] as number[],
  };
  private shuttingDown = false;
  private workerFailures = 0;
  private readonly maxWorkerFailures = 3;

  constructor(config: PoolConfig = {}) {
    const cpuCount = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this.config = {
      size: config.size ?? Math.max(1, Math.min(cpuCount - 1, 4)),
      maxPending: config.maxPending ?? 100,
      timeout: config.timeout ?? 30000,
    };
  }

  initialize(): void {
    if (this.workers.length > 0) return;

    for (let i = 0; i < this.config.size; i++) {
      this.spawnWorker();
    }

    Logger.info(`Worker pool initialized with ${this.config.size} workers`);
  }

  private spawnWorker(): Worker {
    const worker = new Worker(__filename, {
      workerData: { poolId: uuidv4().slice(0, 8) },
    });

    worker.on('message', (msg: WorkerResultMessage) => this.handleWorkerMessage(worker, msg));
    worker.on('error', (error: Error) => this.handleWorkerError(worker, error));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));

    this.workers.push(worker);
    return worker;
  }

  private handleWorkerMessage(worker: Worker, msg: WorkerResultMessage): void {
    const task = this.activeTasks.get(msg.taskId);
    if (!task) return;

    this.activeTasks.delete(msg.taskId);
    this.workerTaskMap.delete(worker);

    const duration = Date.now() - task.createdAt;
    this.stats.taskDurations.push(duration);
    if (this.stats.taskDurations.length > 100) {
      this.stats.taskDurations.shift();
    }

    if (msg.success) {
      this.stats.completedTasks++;
      task.resolve(msg.data);
    } else {
      this.stats.failedTasks++;
      task.reject(new Error(String(msg.error || 'Task failed')));
    }

    this.processQueue();
  }

  private handleWorkerError(worker: Worker, error: Error): void {
    Logger.error(`Worker error: ${error.message}`);
    this.workerFailures++;

    const taskId = this.workerTaskMap.get(worker);
    if (taskId) {
      const task = this.activeTasks.get(taskId);
      if (task) {
        task.reject(error);
        this.activeTasks.delete(taskId);
        this.stats.failedTasks++;
      }
    }

    if (this.workerFailures < this.maxWorkerFailures) {
      const newWorker = this.spawnWorker();
      this.redistributeTasks(worker, newWorker);
    }

    this.removeWorker(worker);
  }

  private handleWorkerExit(worker: Worker, code: number): void {
    if (code !== 0) {
      Logger.warn(`Worker exited with code ${code}`);
    }
    this.removeWorker(worker);
  }

  private removeWorker(worker: Worker): void {
    const idx = this.workers.indexOf(worker);
    if (idx > -1) {
      this.workers.splice(idx, 1);
    }
  }

  private redistributeTasks(fromWorker: Worker, toWorker: Worker): void {
    const taskId = this.workerTaskMap.get(fromWorker);
    if (!taskId) return;

    const task = this.activeTasks.get(taskId);
    if (task) {
      this.activeTasks.delete(taskId);
      this.workerTaskMap.delete(fromWorker);

      const msg: WorkerTaskMessage = {
        type: 'task',
        taskId: task.id,
        data: task.data,
        timeout: task.timeout,
      };
      toWorker.postMessage(msg);
      this.activeTasks.set(task.id, task);
      this.workerTaskMap.set(toWorker, task.id);
    }
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;
    if (this.workers.length === 0) return;

    this.taskQueue.sort((a, b) => a.priority - b.priority);

    const availableWorkers = this.workers.filter((w) => !this.workerTaskMap.has(w));
    if (availableWorkers.length === 0) return;

    const tasksToProcess = Math.min(this.taskQueue.length, availableWorkers.length);

    for (let i = 0; i < tasksToProcess; i++) {
      const task = this.taskQueue.shift()!;
      const worker = availableWorkers[i];

      this.activeTasks.set(task.id, task);
      this.workerTaskMap.set(worker, task.id);
      this.stats.totalTasks++;

      const msg: WorkerTaskMessage = {
        type: 'task',
        taskId: task.id,
        data: task.data,
        timeout: task.timeout || this.config.timeout,
      };
      worker.postMessage(msg);

      if (task.timeout) {
        setTimeout(() => this.handleTaskTimeout(task), task.timeout);
      }
    }
  }

  private handleTaskTimeout(task: InternalTask): void {
    if (this.activeTasks.has(task.id)) {
      this.activeTasks.delete(task.id);
      this.stats.failedTasks++;
      task.reject(new Error(`Task timeout after ${task.timeout}ms`));

      const worker = Array.from(this.workerTaskMap.entries()).find(([, id]) => id === task.id)?.[0];
      if (worker) {
        this.workerFailures++;
        if (this.workerFailures < this.maxWorkerFailures) {
          const newWorker = this.spawnWorker();
          this.redistributeTasks(worker, newWorker);
        }
        this.removeWorker(worker);
      }

      this.processQueue();
    }
  }

  async submit<T = unknown>(data: unknown, priority = 0, timeout?: number): Promise<T> {
    if (this.shuttingDown) {
      throw new Error('Pool is shutting down');
    }

    return new Promise((resolve, reject) => {
      const task: InternalTask = {
        id: uuidv4(),
        data,
        priority,
        createdAt: Date.now(),
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (this.activeTasks.size + this.taskQueue.length >= this.config.maxPending) {
        reject(new Error('Task queue is full'));
        return;
      }

      this.taskQueue.push(task);
      this.processQueue();
    });
  }

  async submitAll<T>(
    tasks: Array<{ data: unknown; priority?: number; timeout?: number }>
  ): Promise<T[]> {
    return Promise.all(tasks.map((t) => this.submit<T>(t.data, t.priority ?? 0, t.timeout)));
  }

  getStats(): WorkerStats {
    const avgDuration =
      this.stats.taskDurations.length > 0
        ? this.stats.taskDurations.reduce((a, b) => a + b, 0) / this.stats.taskDurations.length
        : 0;

    return {
      totalTasks: this.stats.totalTasks,
      completedTasks: this.stats.completedTasks,
      failedTasks: this.stats.failedTasks,
      activeWorkers: this.workers.length,
      pendingTasks: this.taskQueue.length,
      avgTaskDuration: Math.round(avgDuration),
    };
  }

  async shutdown(graceful = true): Promise<void> {
    this.shuttingDown = true;

    if (graceful) {
      while (this.activeTasks.size > 0 || this.taskQueue.length > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.taskQueue = [];
    this.activeTasks.clear();
    this.workerTaskMap.clear();

    Logger.info('Worker pool shut down');
  }
}

export const workerPool = new WorkerPool();

workerPool.initialize();

export { WorkerPool };
