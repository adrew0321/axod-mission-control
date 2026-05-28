import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const dk = scrypt(new TextEncoder().encode(plain), salt, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = hexToBytes(saltHex);
  const expected = hexToBytes(hashHex);
  const actual = scrypt(new TextEncoder().encode(plain), salt, { N, r, p, dkLen: expected.length });
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
