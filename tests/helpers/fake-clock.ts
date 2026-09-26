import type { Clock } from '../../src/clock.ts';

/** A manually advanced clock for deterministic tests. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Date | string) {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  set(to: Date | string): void {
    this.#ms = new Date(to).getTime();
  }

  advance(ms: number): void {
    this.#ms += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}
