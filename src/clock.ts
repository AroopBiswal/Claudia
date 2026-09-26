/** Source of the current time. Everything time-dependent takes a Clock so tests can use a fake one. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
