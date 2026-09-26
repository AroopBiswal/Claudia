import { createHash, timingSafeEqual } from 'node:crypto';

/** RFC 7636 S256: verifies that `verifier` hashes to `challenge`. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const computedBuf = Buffer.from(computed);
  const challengeBuf = Buffer.from(challenge);
  if (computedBuf.length !== challengeBuf.length) return false;
  return timingSafeEqual(computedBuf, challengeBuf);
}
