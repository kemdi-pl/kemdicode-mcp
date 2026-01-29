/**
 * Type declarations for Bun runtime
 * These augment the global scope when running under Bun
 */

declare const Bun: {
  /**
   * Bun.file - Create a BunFile instance for efficient file operations
   */
  file(path: string): BunFile;

  /**
   * Bun.write - Write data to a file (3-5x faster than fs.writeFile)
   */
  write(
    path: string,
    data: string | Buffer | ArrayBuffer | Uint8Array | Blob | BunFile
  ): Promise<void>;
  write(path: string, data: Response): Promise<void>;

  /**
   * Bun.CryptoHasher - Fast cryptographic hashing (2-3x faster than Node.js crypto)
   */
  CryptoHasher: new (algorithm: 'sha256' | 'sha512' | 'md5' | 'sha1') => CryptoHasher;

  /**
   * Bun.Glob - Fast glob pattern matching
   */
  Glob: new (pattern: string) => Glob;

  /**
   * Bun.gc - Force garbage collection (when --expose-gc is enabled)
   */
  gc(force?: boolean): void;

  /**
   * Bun version
   */
  version: string;
};

interface BunFile {
  /**
   * Check if file exists
   */
  exists(): Promise<boolean>;

  /**
   * Get file size in bytes
   */
  size: number;

  /**
   * Get last modified timestamp
   */
  lastModified: number;

  /**
   * Read file as text
   */
  text(): Promise<string>;

  /**
   * Read file as ArrayBuffer
   */
  arrayBuffer(): Promise<ArrayBuffer>;

  /**
   * Read file as Blob
   */
  blob(): Promise<Blob>;

  /**
   * Read file as JSON
   */
  json<T = unknown>(): Promise<T>;

  /**
   * Get readable stream
   */
  stream(): ReadableStream<Uint8Array>;
}

interface CryptoHasher {
  /**
   * Update hash with data
   */
  update(data: string | ArrayBufferView): CryptoHasher;

  /**
   * Get digest as hex string or Buffer
   */
  digest(encoding?: 'hex' | 'base64' | 'buffer'): string | Buffer;

  /**
   * Get algorithm name
   */
  algorithm: string;
}

interface Glob {
  /**
   * Scan files matching the pattern
   */
  scan(root?: string): AsyncIterableIterator<string>;

  /**
   * Synchronous scan
   */
  scanSync(root?: string): IterableIterator<string>;
}

/**
 * Bun-specific additions to global crypto object
 */
declare interface Crypto {
  /**
   * Get random values (Bun uses optimized implementation)
   */
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

declare const crypto: Crypto;
