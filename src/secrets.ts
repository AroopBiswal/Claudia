import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Loads a secret from `path`, creating it if it does not exist yet.
 *
 * The parent directory is created with mode 0700 (if missing) and the secret
 * file is created exclusively (O_EXCL) with mode 0600, so a concurrent caller
 * can never race a partially written secret into existence. The secret's
 * bytes are never logged.
 */
export function loadOrCreateSecret(path: string, bytes = 32): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      const secret = randomBytes(bytes);
      writeSync(fd, secret);
      return secret;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return readFileSync(path);
    }
    throw error;
  }
}

/** Reads a text secret (e.g. a token), trimming trailing whitespace. Returns null if missing. */
export function readSecretText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
