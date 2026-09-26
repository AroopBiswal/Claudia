import { describe, expect, it } from 'vitest';
import { matchRules, sensitiveGuard, type Rule } from '../../../src/vault/rules.ts';

function rule(text: string, keywords: string[], id: string | null = null): Rule {
  return { id, text, keywords };
}

describe('sensitiveGuard: formatted phone numbers near an ID/account word (bug fix)', () => {
  // Bug: a formatted phone number (3-3-4, with separators or parentheses) near an ID/account
  // word used to be treated as an ID/account number and refused. Only an unformatted run of
  // digits should ever trigger rule 4 (hasIdNumberNearby).
  const shouldNotRefuse: Array<[string, string]> = [
    ['Call the credit card company at 415-555-0100', 'dashed phone near "credit card"'],
    [
      'Remind me to call my insurance about the policy, their number is (800) 555-0199',
      'parenthesized phone, no adjacent ID word (control case)',
    ],
    ['My account manager is at 415-555-0100', 'dashed phone near "account"'],
    ['Card support line: (800) 555-0199', 'parenthesized phone near "card"'],
    ['Call the passport office at +1 415-555-0100', 'phone with +1 near "passport"'],
    ['Routing info: call 415-555-0100 to confirm', 'dashed phone near "routing"'],
    ['My license renewal office number is 415-555-0100.', 'dashed phone near "license"'],
  ];

  it.each(shouldNotRefuse)('does not refuse: %s (%s)', (text) => {
    expect(sensitiveGuard(text)).toBeNull();
  });

  it('still refuses an unformatted digit run near an ID word (regression guard)', () => {
    expect(sensitiveGuard('account number 12345678')).not.toBeNull();
    expect(sensitiveGuard('account number 12345678')).toEqual({
      reason: 'Looks like an account or ID number; Claudia never saves those.',
    });
  });

  it('still refuses an unformatted digit run even when a phone number appears elsewhere in the same text', () => {
    // The phone number itself must be ignored, but a real account number nearby still refuses.
    expect(sensitiveGuard('Call 415-555-0100, my account number is 88771234')).not.toBeNull();
  });

  it('still refuses a long unformatted digit run unrelated to any ID word (hasLongDigitRun)', () => {
    expect(sensitiveGuard('The confirmation code is 123456789012')).not.toBeNull();
  });

  it('still refuses an SSN-shaped 3-2-4 pattern (not phone-shaped, so unaffected by the fix)', () => {
    expect(sensitiveGuard('His SSN is 123-45-6789')).not.toBeNull();
  });
});

describe('matchRules: keywords containing regex metacharacters', () => {
  it('matches a literal "c++" keyword without the metacharacters acting as regex operators', () => {
    const rules = [rule('Nothing about c++', ['c++'])];
    expect(matchRules(['I am learning c++ this week'], rules)).toEqual({
      rule: rules[0],
      keyword: 'c++',
    });
    // If '+' were treated as a regex quantifier this would also match "c" alone; it must not.
    expect(matchRules(['I love the letter c'], rules)).toBeNull();
  });

  it('matches a literal "a.b" keyword, not "a" then any-character then "b"', () => {
    const rules = [rule('Nothing about a.b', ['a.b'])];
    expect(matchRules(['the file is a.b today'], rules)).toEqual({
      rule: rules[0],
      keyword: 'a.b',
    });
    // '.' must not act as a wildcard: "aXb" must not match.
    expect(matchRules(['the file is aXb today'], rules)).toBeNull();
  });

  it('matches a literal "(x)" keyword, parentheses treated as plain characters', () => {
    const rules = [rule('Nothing about (x)', ['(x)'])];
    expect(matchRules(['see (x) in the diagram'], rules)).toEqual({
      rule: rules[0],
      keyword: '(x)',
    });
    expect(matchRules(['see x in the diagram'], rules)).toBeNull();
  });

  it('handles a keyword that is nothing but metacharacters without throwing', () => {
    const rules = [rule('Nothing about $^*', ['$^*'])];
    expect(() => matchRules(['literal $^* here'], rules)).not.toThrow();
  });
});

describe('matchRules: performance with many rules', () => {
  it('checks 200 rules against a 2 KB text in well under 50ms', () => {
    const rules: Rule[] = Array.from({ length: 200 }, (_, i) =>
      rule(`Rule ${i}`, [`keyword${i}`, `phrase ${i} words`]),
    );
    // ~2KB of realistic prose, containing no keyword matches at all (worst case: scans everything).
    const paragraph =
      'Remind me to call the dentist tomorrow morning and also pick up the dry cleaning ' +
      'before the weekend starts, then check in with the team about the quarterly planning ' +
      'document and see whether Alex has any updates on the travel itinerary for next month. ';
    const text = paragraph.repeat(Math.ceil(2048 / paragraph.length));

    // Warm up: the very first Unicode-property-escape regex compiled in a process pays a one-time
    // JIT/engine setup cost unrelated to this function's steady-state cost (measured ~100ms+ cold
    // vs. well under 1ms warm on this suite's hardware). Every call after the first in a running
    // Claudia server pays only the steady-state cost, so that is what this budget checks.
    matchRules(['warm up'], rules);

    const start = performance.now();
    const result = matchRules([text], rules);
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(50);
  });
});
