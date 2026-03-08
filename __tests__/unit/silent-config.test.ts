/**
 * KemdiCode MCP Server
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isSilent,
  isStrictSilent,
  getOutputLevel,
  setOutputLevel,
  initSilentFromEnv,
  resolveOutputLevel,
  type OutputLevel,
} from '../../src/config/silent.js';

describe('Silent Config', () => {
  let originalLevel: OutputLevel;

  beforeEach(() => {
    originalLevel = getOutputLevel();
  });

  afterEach(() => {
    setOutputLevel(originalLevel);
    delete process.env.KEMDICODE_OUTPUT;
    delete process.env.KEMDICODE_SILENT;
  });

  describe('setOutputLevel / getOutputLevel', () => {
    it('should set and get silent level', () => {
      setOutputLevel('silent');
      expect(getOutputLevel()).toBe('silent');
    });

    it('should set and get compact level', () => {
      setOutputLevel('compact');
      expect(getOutputLevel()).toBe('compact');
    });

    it('should set and get normal level', () => {
      setOutputLevel('normal');
      expect(getOutputLevel()).toBe('normal');
    });
  });

  describe('isSilent', () => {
    it('should return true for silent level', () => {
      setOutputLevel('silent');
      expect(isSilent()).toBe(true);
    });

    it('should return true for compact level', () => {
      setOutputLevel('compact');
      expect(isSilent()).toBe(true);
    });

    it('should return false for normal level', () => {
      setOutputLevel('normal');
      expect(isSilent()).toBe(false);
    });
  });

  describe('isStrictSilent', () => {
    it('should return true only for silent level', () => {
      setOutputLevel('silent');
      expect(isStrictSilent()).toBe(true);
    });

    it('should return false for compact level', () => {
      setOutputLevel('compact');
      expect(isStrictSilent()).toBe(false);
    });

    it('should return false for normal level', () => {
      setOutputLevel('normal');
      expect(isStrictSilent()).toBe(false);
    });
  });

  describe('initSilentFromEnv', () => {
    it('should set normal from KEMDICODE_OUTPUT=verbose', () => {
      process.env.KEMDICODE_OUTPUT = 'verbose';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('normal');
    });

    it('should set normal from KEMDICODE_OUTPUT=normal', () => {
      process.env.KEMDICODE_OUTPUT = 'normal';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('normal');
    });

    it('should set normal from KEMDICODE_OUTPUT=0', () => {
      process.env.KEMDICODE_OUTPUT = '0';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('normal');
    });

    it('should set normal from KEMDICODE_OUTPUT=false', () => {
      process.env.KEMDICODE_OUTPUT = 'false';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('normal');
    });

    it('should set compact from KEMDICODE_OUTPUT=compact', () => {
      process.env.KEMDICODE_OUTPUT = 'compact';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('compact');
    });

    it('should set silent from KEMDICODE_OUTPUT=1', () => {
      setOutputLevel('normal'); // start from normal
      process.env.KEMDICODE_OUTPUT = '1';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('silent');
    });

    it('should set silent from KEMDICODE_OUTPUT=true', () => {
      setOutputLevel('normal');
      process.env.KEMDICODE_OUTPUT = 'true';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('silent');
    });

    it('should fall back to KEMDICODE_SILENT env var', () => {
      process.env.KEMDICODE_SILENT = 'false';
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('normal');
    });

    it('should not change level when no env var is set', () => {
      setOutputLevel('compact');
      initSilentFromEnv();
      expect(getOutputLevel()).toBe('compact');
    });
  });

  describe('resolveOutputLevel', () => {
    it('should return silent when perCallSilent is true', () => {
      setOutputLevel('normal');
      expect(resolveOutputLevel(true)).toBe('silent');
    });

    it('should return silent when perCallSilent is "true"', () => {
      setOutputLevel('normal');
      expect(resolveOutputLevel('true')).toBe('silent');
    });

    it('should return silent when perCallSilent is "silent"', () => {
      setOutputLevel('normal');
      expect(resolveOutputLevel('silent')).toBe('silent');
    });

    it('should return compact when perCallSilent is "compact"', () => {
      setOutputLevel('normal');
      expect(resolveOutputLevel('compact')).toBe('compact');
    });

    it('should return global level when perCallSilent is undefined', () => {
      setOutputLevel('compact');
      expect(resolveOutputLevel(undefined)).toBe('compact');
    });

    it('should return global level when perCallSilent is false', () => {
      setOutputLevel('normal');
      expect(resolveOutputLevel(false as unknown as boolean)).toBe('normal');
    });
  });
});
