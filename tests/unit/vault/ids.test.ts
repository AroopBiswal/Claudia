import { describe, expect, it } from 'vitest';
import { newBlockId } from '../../../src/vault/ids.ts';

describe('newBlockId', () => {
  it('produces a kind letter plus 4 lowercase alphanumeric chars', () => {
    const id = newBlockId(
      't',
      () => false,
      () => 0,
    );
    expect(id).toMatch(/^t[a-z0-9]{4}$/);
    expect(id).toBe('taaaa');
  });

  it('uses the given random source deterministically', () => {
    const id = newBlockId(
      'a',
      () => false,
      () => 0.999999,
    );
    expect(id).toBe('a9999');
  });

  it('retries on collision until an untaken id is found', () => {
    const seen: string[] = [];
    let calls = 0;
    const random = () => {
      // First call sequence produces "aaaa" (taken), second produces "bbbb".
      const seq = calls < 4 ? 0 : 1 / 36 + 0.001;
      calls++;
      return seq;
    };
    const taken = (id: string) => {
      seen.push(id);
      return id === 'faaaa';
    };
    const id = newBlockId('f', taken, random);
    expect(seen[0]).toBe('faaaa');
    expect(id).not.toBe('faaaa');
  });

  it('throws after 1000 failed attempts', () => {
    expect(() =>
      newBlockId(
        'r',
        () => true,
        () => 0,
      ),
    ).toThrow(/1000/);
  });
});
