import { describe, expect, it } from 'vitest';
import {
  matchRules,
  normalizeKeywords,
  refusalReason,
  sensitiveGuard,
  type Rule,
} from '../../../src/vault/rules.ts';

function rule(text: string, keywords: string[], id: string | null = null): Rule {
  return { id, text, keywords };
}

describe('matchRules', () => {
  it('matches a single-word keyword as a whole word only', () => {
    const rules = [rule('Nothing about art', ['art'])];
    expect(matchRules(['I love art'], rules)).toEqual({ rule: rules[0], keyword: 'art' });
    expect(matchRules(['I went to a party'], rules)).toBeNull();
  });

  it('matches a multi-word phrase keyword', () => {
    const rules = [rule('Nothing about my mental health', ['mental health'])];
    expect(matchRules(["Let's talk about mental health today"], rules)).toEqual({
      rule: rules[0],
      keyword: 'mental health',
    });
    expect(matchRules(['Just a mental note to self'], rules)).toBeNull();
  });

  it('matches the simple plural of a single-word keyword', () => {
    const rules = [rule('Nothing about my therapist', ['therapist'])];
    expect(matchRules(['My therapists called today'], rules)).toEqual({
      rule: rules[0],
      keyword: 'therapist',
    });
    expect(matchRules(['My therapist called today'], rules)).toEqual({
      rule: rules[0],
      keyword: 'therapist',
    });
  });

  it('matches case-insensitively', () => {
    const rules = [rule('Nothing about therapy', ['therapy'])];
    expect(matchRules(['THERAPY session at noon'], rules)).toEqual({
      rule: rules[0],
      keyword: 'therapy',
    });
  });

  it('matches unicode words exactly, accents included', () => {
    const rules = [rule('Nothing about the café', ['café'])];
    expect(matchRules(['Meet me at the Café tonight'], rules)).toEqual({
      rule: rules[0],
      keyword: 'café',
    });
    expect(matchRules(['Meet me at the cafe tonight'], rules)).toBeNull();
  });

  it('respects punctuation and hyphen boundaries', () => {
    const rules = [rule('Nothing about my ex', ['ex'])];
    expect(matchRules(['My ex called'], rules)).toEqual({ rule: rules[0], keyword: 'ex' });
    expect(matchRules(['mother-in-law visited'], rules)).toBeNull();
  });

  it('checks every text and every rule, returning null when nothing matches', () => {
    const rules = [rule('Nothing about therapy', ['therapy']), rule('Nothing about exes', ['ex'])];
    expect(matchRules(['just groceries', 'and a walk'], rules)).toBeNull();
    expect(matchRules(['just groceries', 'saw my ex today'], rules)).toEqual({
      rule: rules[1],
      keyword: 'ex',
    });
  });

  it('ignores empty keywords without throwing', () => {
    const rules = [rule('Odd rule', ['', '   ', 'therapy'])];
    expect(matchRules(['therapy today'], rules)).toEqual({ rule: rules[0], keyword: 'therapy' });
  });

  it('returns null for an empty rule list or empty texts', () => {
    expect(matchRules(['anything'], [])).toBeNull();
    expect(matchRules([], [rule('r', ['x'])])).toBeNull();
  });
});

describe('refusalReason', () => {
  it('formats the rule text and matched keyword', () => {
    const match = {
      rule: rule('Nothing about my therapy sessions', ['therapy', 'therapist', 'counseling']),
      keyword: 'therapy',
    };
    expect(refusalReason(match)).toBe(
      'Matches your never-save rule "Nothing about my therapy sessions" (therapy).',
    );
  });
});

describe('normalizeKeywords', () => {
  it('trims, lowercases and dedupes', () => {
    expect(normalizeKeywords([' Therapy ', 'therapy', 'Counseling'])).toEqual([
      'therapy',
      'counseling',
    ]);
  });

  it('drops empties and stray commas', () => {
    expect(normalizeKeywords(['', '   ', ',', ',therapy,', 'a,'])).toEqual(['therapy', 'a']);
  });

  it('caps the result at 20 keywords', () => {
    const many = Array.from({ length: 30 }, (_, i) => `keyword${i}`);
    expect(normalizeKeywords(many)).toHaveLength(20);
  });
});

describe('sensitiveGuard', () => {
  const positives: Array<[string, string]> = [
    ['My wifi password is Sunflower22', 'wifi password'],
    ['The Netflix password: hunter2', 'colon password'],
    ['Update the account password = Tr0ub4dor&3', 'equals password'],
    ['His PIN was 4471', 'pin was'],
    ['The PIN code is 8842', 'pin code'],
    ['The card CVV is 123', 'cvv'],
    ['CVC: 456', 'cvc'],
    ['The garage security code is 778899', 'security code'],
    ['The 2FA code is 483920', '2fa code'],
    ['MFA code: 019283', 'mfa code'],
    ['The OTP code was 552210', 'otp code'],
    ['Recovery code is ABCD-1234-EFGH', 'recovery code'],
    ['Backup code: XJ29-QW11', 'backup code'],
    ['My seed phrase is apple banana cherry dog elephant', 'seed phrase'],
    ['Recovery phrase: witch collapse practice feed', 'recovery phrase'],
    ['The private key is 5J3mBbLxyz9', 'private key'],
    ['API key: sk-live-12345abcdef', 'api key'],
    ['The secret key = abcdef123456', 'secret key'],
    ['Access token is ghp_abcdEFGH1234', 'access token'],
    ['His SSN is 123-45-6789', 'ssn dash pattern'],
    ['My bank account number is 12345678901234', 'long digit run'],
    ['Wire to routing number 021000021 account 000123456789', 'routing plus account'],
    ['Card number 483920 was declined', 'card id word'],
    ['Member ID 552211 needs updating', 'member id'],
    ['Policy number finalized: 778899', 'policy number'],
    ['Tax ID 123456789 is on the form', 'tax id'],
    ['Passport number 234567812 expires soon', 'passport number'],
    ["Driver's license number is 456789", 'license number'],
    ['National ID: 998877', 'national id'],
    ['Aadhaar number 234567890123', 'aadhaar'],
    ['PAN number is 654321', 'pan number'],
  ];

  it.each(positives)('refuses: %s (%s)', (text) => {
    expect(sensitiveGuard(text)).not.toBeNull();
  });

  it('gives a generic password/security-code reason', () => {
    expect(sensitiveGuard('My wifi password is Sunflower22')).toEqual({
      reason: 'Looks like a password or security code; Claudia never saves those.',
    });
  });

  it('gives a generic account/ID-number reason', () => {
    expect(sensitiveGuard('His SSN is 123-45-6789')).toEqual({
      reason: 'Looks like an account or ID number; Claudia never saves those.',
    });
  });

  const negatives: Array<[string, string]> = [
    ['Change my Netflix password tomorrow', 'no value given'],
    ['Reset the wifi password', 'no value given 2'],
    ['Remind me to update my password next week', 'no value given 3'],
    ["The password hint is your pet's name", 'not the secret itself'],
    ['Call the dentist at 2026-09-29 09:00', 'date and time'],
    ['Flight UA 1234 departs at 10:15am', 'flight number'],
    ['Dinner reservation for 9/29/2026 at 7pm', 'slash date'],
    ['Meet Alex at (415) 555-0100', 'parenthesized phone'],
    ['Text Sam at 415-555-0100 tomorrow', 'dashed phone'],
    ['Call +1 415 555 0100 about the trip', 'international phone'],
    ['His number is 4155550100', 'bare 10-digit phone'],
    ['Address: 1600 Amphitheatre Pkwy, Mountain View, CA 94043', 'street address'],
    ['Grab milk, eggs, and bread', 'grocery list'],
    ['The zip code is 94043', 'zip code'],
    ['Meet in room 214 at 3pm', 'room number'],
    ['Born in 1990', 'year'],
    ['Renew passport before the trip', 'id word no digits'],
    ['Pay the $129.99 invoice by Friday', 'price'],
    ['Lunch costs $15', 'price 2'],
    ['Laundry every week on Sunday', 'repeat rule'],
    ["Doctor's appointment on 2026-10-05", 'iso date'],
    ['The meeting is at 3pm tomorrow', 'ordinary reminder'],
    ['My PTO starts on 2026-11-01', 'dashed date'],
    ['Order confirmation number ABCD1234', 'alphanumeric code'],
    ['Zoom meeting ID is 89234567123 today', 'meeting id not an id word'],
    ['Room 1408, checkout at 11am', 'room number 2'],
    ['Card game night is Friday', 'card word no digits'],
    ['Social security offices close at 5pm', 'id phrase no digits'],
    ['Renew the passport at the county office', 'id word no digits 2'],
    ['Pick up the kids at 5:30', 'time only'],
  ];

  it.each(negatives)('does not refuse: %s (%s)', (text) => {
    expect(sensitiveGuard(text)).toBeNull();
  });
});
