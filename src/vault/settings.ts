import { IANAZone } from 'luxon';

export interface Settings {
  timeZone: string;
  briefTime: string;
  nudgeTime: string;
  waitingNudgeDays: number;
  briefFallbackMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  timeZone: 'America/Los_Angeles',
  briefTime: '07:30',
  nudgeTime: '09:00',
  waitingNudgeDays: 5,
  briefFallbackMinutes: 90,
};

export const SETTING_KEYS = [
  'Time zone',
  'Brief time',
  'Nudge time',
  'Waiting-on nudge after',
  'Brief fallback after',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const DAY_WORDS = ['days', 'day'];
const MINUTE_WORDS = ['minutes', 'minute', 'mins', 'min'];

/** Bullet used at the start of a Markdown list item: -, *, +, or 1. / 1) */
const BULLET_SOURCE = '(?:[-*+]|\\d+[.)])';

function normalizeKeyText(key: string): string {
  return key.trim().replace(/\s+/g, ' ');
}

function findKey(key: string): SettingKey | null {
  const normalized = normalizeKeyText(key).toLowerCase();
  return SETTING_KEYS.find((candidate) => candidate.toLowerCase() === normalized) ?? null;
}

function defaultValueText(key: SettingKey): string {
  switch (key) {
    case 'Time zone':
      return DEFAULT_SETTINGS.timeZone;
    case 'Brief time':
      return DEFAULT_SETTINGS.briefTime;
    case 'Nudge time':
      return DEFAULT_SETTINGS.nudgeTime;
    case 'Waiting-on nudge after':
      return `${DEFAULT_SETTINGS.waitingNudgeDays} days`;
    case 'Brief fallback after':
      return `${DEFAULT_SETTINGS.briefFallbackMinutes} minutes`;
  }
}

function describeExpectation(key: SettingKey): string {
  switch (key) {
    case 'Time zone':
      return 'is not a recognized time zone';
    case 'Brief time':
    case 'Nudge time':
      return 'is not a time like 07:30';
    case 'Waiting-on nudge after':
      return 'is not a number of days from 1 to 60';
    case 'Brief fallback after':
      return 'is not a number of minutes from 15 to 720';
  }
}

function normalizeTime(value: string): string | null {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim());
  if (!match) return null;
  const hourText = match[1] ?? '';
  const minuteText = match[2] ?? '';
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseCount(value: string, unitWords: string[]): number | null {
  const trimmed = value.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare) return Number.parseInt(bare[1] ?? '', 10);
  const unitPattern = unitWords.join('|');
  const withUnit = new RegExp(`^(\\d+)\\s+(?:${unitPattern})$`, 'i').exec(trimmed);
  if (withUnit) return Number.parseInt(withUnit[1] ?? '', 10);
  return null;
}

export function validateSetting(
  key: string,
  value: string,
): { ok: true; key: SettingKey; value: string } | { ok: false; error: string } {
  const normalizedKey = findKey(key);
  if (!normalizedKey) {
    return { ok: false, error: `Unknown setting "${key}".` };
  }

  const trimmedValue = value.trim();

  if (normalizedKey === 'Time zone') {
    if (!trimmedValue || !IANAZone.isValidZone(trimmedValue)) {
      return {
        ok: false,
        error: `"${normalizedKey}" value "${value}" ${describeExpectation(normalizedKey)}.`,
      };
    }
    return { ok: true, key: normalizedKey, value: trimmedValue };
  }

  if (normalizedKey === 'Brief time' || normalizedKey === 'Nudge time') {
    const time = normalizeTime(trimmedValue);
    if (time === null) {
      return {
        ok: false,
        error: `"${normalizedKey}" value "${value}" ${describeExpectation(normalizedKey)}.`,
      };
    }
    return { ok: true, key: normalizedKey, value: time };
  }

  if (normalizedKey === 'Waiting-on nudge after') {
    const days = parseCount(trimmedValue, DAY_WORDS);
    if (days === null || days < 1 || days > 60) {
      return {
        ok: false,
        error: `"${normalizedKey}" value "${value}" ${describeExpectation(normalizedKey)}.`,
      };
    }
    return { ok: true, key: normalizedKey, value: `${days} days` };
  }

  // Brief fallback after
  const minutes = parseCount(trimmedValue, MINUTE_WORDS);
  if (minutes === null || minutes < 15 || minutes > 720) {
    return {
      ok: false,
      error: `"${normalizedKey}" value "${value}" ${describeExpectation(normalizedKey)}.`,
    };
  }
  return { ok: true, key: normalizedKey, value: `${minutes} minutes` };
}

function applySetting(settings: Settings, key: SettingKey, value: string): void {
  switch (key) {
    case 'Time zone':
      settings.timeZone = value;
      break;
    case 'Brief time':
      settings.briefTime = value;
      break;
    case 'Nudge time':
      settings.nudgeTime = value;
      break;
    case 'Waiting-on nudge after':
      settings.waitingNudgeDays = Number.parseInt(value, 10);
      break;
    case 'Brief fallback after':
      settings.briefFallbackMinutes = Number.parseInt(value, 10);
      break;
  }
}

interface ParsedListLine {
  key: string;
  value: string;
}

/**
 * Walks the lines of a note, tracking frontmatter and fenced code blocks, and
 * yields the key/value pair of every `<bullet> Key: value` list line found
 * outside of them. Frontmatter and fences are never parsed as settings.
 */
function forEachSettingLine(text: string, callback: (line: ParsedListLine) => void): void {
  const lines = text.split(/\r\n|\n/);
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let inFence = false;

  lines.forEach((rawLine, index) => {
    if (index === 0 && !frontmatterClosed && rawLine.trim() === '---') {
      inFrontmatter = true;
      return;
    }
    if (inFrontmatter) {
      if (rawLine.trim() === '---') {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      return;
    }
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const listMatch = new RegExp(`^\\s*${BULLET_SOURCE}\\s+([^:]+):\\s*(.*)$`).exec(rawLine);
    if (!listMatch) return;
    const key = listMatch[1] ?? '';
    const value = listMatch[2] ?? '';
    callback({ key, value });
  });
}

export function parseSettings(text: string): { settings: Settings; warnings: string[] } {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  const seen = new Set<SettingKey>();

  forEachSettingLine(text, ({ key: rawKey, value: rawValue }) => {
    const key = findKey(rawKey);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const result = validateSetting(key, rawValue);
    if (result.ok) {
      applySetting(settings, key, result.value);
    } else {
      warnings.push(
        `Settings: "${key}" value "${rawValue.trim()}" ${describeExpectation(key)}; using ${defaultValueText(key)}.`,
      );
    }
  });

  return { settings, warnings };
}

export function setSettingInText(text: string, key: SettingKey, value: string): string {
  const parts = text.split(/(\r\n|\n)/);
  const isLineEnding = (part: string | undefined): boolean => part === '\r\n' || part === '\n';

  let inFrontmatter = false;
  let frontmatterClosed = false;
  let inFence = false;
  let lastSettingContentIndex = -1;
  let foundContentIndex = -1;

  const lineRegex = new RegExp(`^(\\s*${BULLET_SOURCE}\\s+)([^:]+:)(\\s*)(.*)$`);

  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';

    if (i === 0 && !frontmatterClosed && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lineRegex.exec(line);
    if (!match) continue;
    const keyPart = match[2] ?? '';
    const matchedKey = findKey(keyPart.slice(0, -1));
    if (!matchedKey) continue;

    lastSettingContentIndex = i;
    if (matchedKey === key) {
      foundContentIndex = i;
    }
  }

  if (foundContentIndex !== -1) {
    const line = parts[foundContentIndex] ?? '';
    const match = lineRegex.exec(line);
    if (match) {
      const prefix = match[1] ?? '';
      const keyPart = match[2] ?? '';
      const spacing = match[3] ?? '';
      parts[foundContentIndex] = `${prefix}${keyPart}${spacing}${value}`;
    }
    return parts.join('');
  }

  const newLine = `- ${key}: ${value}`;

  if (lastSettingContentIndex !== -1) {
    const sepAfter = parts[lastSettingContentIndex + 1];
    if (isLineEnding(sepAfter)) {
      parts.splice(lastSettingContentIndex + 2, 0, newLine, sepAfter as string);
    } else {
      // The last setting line is also the last line in the file, with no trailing newline.
      parts.splice(lastSettingContentIndex + 1, 0, '\n', newLine);
    }
    return parts.join('');
  }

  // No existing setting line: append at the end of the file.
  if (parts.length === 0) {
    return newLine;
  }
  const lastIndex = parts.length - 1;
  const lastContent = parts[lastIndex] ?? '';
  if (lastContent === '' && isLineEnding(parts[lastIndex - 1])) {
    // File ends with a trailing newline: replace the trailing empty element.
    parts[lastIndex] = newLine;
    return parts.join('');
  }
  parts.push('\n', newLine);
  return parts.join('');
}
