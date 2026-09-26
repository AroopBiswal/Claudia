export interface Rule {
  id: string | null;
  text: string;
  keywords: string[];
}

export interface RuleMatch {
  rule: Rule;
  keyword: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A Unicode-aware "word" character: any letter or digit, in any script. */
const WORD_CHAR_SOURCE = '\\p{L}\\p{N}';

/**
 * Builds a whole-word (Unicode-aware), case-insensitive matcher for a
 * keyword or short phrase. Multi-word phrases match with any run of
 * whitespace between the words. A single-word keyword also matches its
 * simple plural (trailing "s" or "es"), so "therapist" matches "therapists".
 */
function buildKeywordRegex(keyword: string): RegExp | null {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const escaped = words.map(escapeRegExp).join('\\s+');
  const pattern = words.length === 1 ? `${escaped}(?:es|s)?` : escaped;

  return new RegExp(`(?<![${WORD_CHAR_SOURCE}])(?:${pattern})(?![${WORD_CHAR_SOURCE}])`, 'iu');
}

export function matchRules(texts: string[], rules: Rule[]): RuleMatch | null {
  const candidates = texts.filter((text) => text.length > 0);
  if (candidates.length === 0) return null;

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      const regex = buildKeywordRegex(keyword);
      if (!regex) continue;
      for (const text of candidates) {
        if (regex.test(text)) {
          return { rule, keyword: keyword.trim() };
        }
      }
    }
  }

  return null;
}

export function refusalReason(match: RuleMatch): string {
  return `Matches your never-save rule "${match.rule.text}" (${match.keyword}).`;
}

export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of keywords) {
    const cleaned = raw
      .trim()
      .replace(/^,+|,+$/g, '')
      .trim()
      .toLowerCase();
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= 20) break;
  }

  return result;
}

// --- Sensitive-data guard (Decision Log B15 / B18: passwords, account and ID
// numbers are never saved; health/financial details are Claude's call.) ---

const SECRET_PHRASES = [
  'pin code',
  'security code',
  '2fa code',
  'mfa code',
  'otp code',
  'recovery code',
  'backup code',
  'seed phrase',
  'recovery phrase',
  'private key',
  'api key',
  'secret key',
  'access token',
  'password',
  'passcode',
  'passphrase',
  'pin',
  'cvv',
  'cvc',
];

function buildAlternation(phrases: string[]): string {
  return phrases.map((phrase) => phrase.split(' ').map(escapeRegExp).join('\\s+')).join('|');
}

const SECRET_TRIGGER_RE = new RegExp(
  `\\b(?:${buildAlternation(SECRET_PHRASES)})\\b\\s{0,3}(?:is\\b|was\\b|:|=)\\s{0,3}\\S`,
  'i',
);

const ID_WORDS = [
  'social security',
  'credit card',
  'debit card',
  "driver's license",
  'drivers license',
  'driver license',
  "driver's licence",
  'drivers licence',
  'member id',
  'id number',
  'policy number',
  'tax id',
  'national id',
  'account',
  'acct',
  'routing',
  'card',
  'ssn',
  'passport',
  'license',
  'licence',
  'ein',
  'itin',
  'aadhaar',
  'pan',
];

const ID_WORD_RE = new RegExp(`\\b(?:${buildAlternation(ID_WORDS)})\\b`, 'gi');

function digitRuns(text: string): number[] {
  const runs: number[] = [];
  const re = /\d(?:[\d\- ]*\d)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    runs.push(match[0].replace(/[^\d]/g, '').length);
  }
  return runs;
}

function hasSsnPattern(text: string): boolean {
  return /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/.test(text);
}

function hasLongDigitRun(text: string): boolean {
  return digitRuns(text).some((count) => count >= 12);
}

// A formatted phone number (3-3-4, US-style), with an optional leading +1 and
// separators of space/dot/dash, or the area code in parentheses. Requires an
// actual separator (or parens) between every group, so a bare unformatted run
// of digits (which might be an account/ID number) never matches here.
const FORMATTED_PHONE_RE =
  /(?<!\d)(?:\+1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;

function stripFormattedPhoneNumbers(text: string): string {
  return text.replace(FORMATTED_PHONE_RE, ' ');
}

function hasIdNumberNearby(text: string): boolean {
  ID_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ID_WORD_RE.exec(text))) {
    const after = text.slice(match.index + match[0].length);
    const words = after.split(/\s+/).filter(Boolean).slice(0, 5);
    const windowText = stripFormattedPhoneNumbers(words.join(' '));
    if (digitRuns(windowText).some((count) => count >= 6)) {
      return true;
    }
    if (match.index === ID_WORD_RE.lastIndex) {
      ID_WORD_RE.lastIndex += 1;
    }
  }
  return false;
}

export function sensitiveGuard(text: string): { reason: string } | null {
  if (SECRET_TRIGGER_RE.test(text)) {
    return { reason: 'Looks like a password or security code; Claudia never saves those.' };
  }

  if (hasSsnPattern(text) || hasLongDigitRun(text) || hasIdNumberNearby(text)) {
    return { reason: 'Looks like an account or ID number; Claudia never saves those.' };
  }

  return null;
}
