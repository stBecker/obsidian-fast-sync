const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c;
}

/**
 * Fast CRC32 hash function. Suitable for quick change detection,
 * but not cryptographically secure. Used for file CONTENT hash.
 */
export async function hashFileContentFast(content: string): Promise<string> {
  let crc = 0xffffffff;
  const len = content.length;
  const chunks = 1024 * 64;

  for (let start = 0; start < len; start += chunks) {
    const end = Math.min(start + chunks, len);
    for (let i = start; i < end; i++) {
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ content.charCodeAt(i)) & 0xff];
    }
  }

  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Cryptographically strong SHA-256 hash function.
 * Used to generate the stable identifier for a file path.
 */
export async function hashStringSHA256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ContentHashCache {
  private cache: Map<string, string> = new Map();

  set(path: string, hash: string) {
    this.cache.set(path, hash);
  }

  get(path: string): string | null {
    return this.cache.get(path) || null;
  }

  invalidate(path: string) {
    this.cache.delete(path);
  }

  clear() {
    this.cache.clear();
  }
}
