import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  setSettingInText,
  validateSetting,
} from '../../../src/vault/settings.ts';

const SEEDED_SETTINGS_MD =
  '---\n' +
  'claudia: settings\n' +
  '---\n' +
  '# Settings\n' +
  '\n' +
  'Claudia reads this note. Change a value after the colon and save; delete a line to go back to the default.\n' +
  '\n' +
  '- Time zone: America/Los_Angeles\n' +
  '- Brief time: 07:30\n' +
  '- Nudge time: 09:00\n' +
  '- Waiting-on nudge after: 5 days\n' +
  '- Brief fallback after: 90 minutes\n';

describe('parseSettings', () => {
  it('returns the defaults with no warnings for an empty note', () => {
    const { settings, warnings } = parseSettings('');
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });

  it('reads the seeded Settings.md back to the defaults', () => {
    const { settings, warnings } = parseSettings(SEEDED_SETTINGS_MD);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });

  it('accepts case-insensitive keys and extra spaces', () => {
    const text = ['- time   zone:   America/New_York', '-   BRIEF TIME:08:15'].join('\n');
    const { settings, warnings } = parseSettings(text);
    expect(settings.timeZone).toBe('America/New_York');
    expect(settings.briefTime).toBe('08:15');
    expect(warnings).toEqual([]);
  });

  it('falls back to defaults silently when a line is missing', () => {
    const text = ['- Time zone: America/Chicago', '- Brief time: 08:00'].join('\n');
    const { settings, warnings } = parseSettings(text);
    expect(settings.timeZone).toBe('America/Chicago');
    expect(settings.briefTime).toBe('08:00');
    expect(settings.nudgeTime).toBe(DEFAULT_SETTINGS.nudgeTime);
    expect(settings.waitingNudgeDays).toBe(DEFAULT_SETTINGS.waitingNudgeDays);
    expect(settings.briefFallbackMinutes).toBe(DEFAULT_SETTINGS.briefFallbackMinutes);
    expect(warnings).toEqual([]);
  });

  it('falls back to the default and warns on a junk time value', () => {
    const text = '- Brief time: 7.30';
    const { settings, warnings } = parseSettings(text);
    expect(settings.briefTime).toBe(DEFAULT_SETTINGS.briefTime);
    expect(warnings).toEqual([
      'Settings: "Brief time" value "7.30" is not a time like 07:30; using 07:30.',
    ]);
  });

  it('falls back to the default and warns on a junk time zone', () => {
    const text = '- Time zone: Mars/Nowhere';
    const { settings, warnings } = parseSettings(text);
    expect(settings.timeZone).toBe(DEFAULT_SETTINGS.timeZone);
    expect(warnings).toEqual([
      'Settings: "Time zone" value "Mars/Nowhere" is not a recognized time zone; using America/Los_Angeles.',
    ]);
  });

  it('falls back to the default and warns on a junk day count', () => {
    const text = '- Waiting-on nudge after: 3 weeks';
    const { settings, warnings } = parseSettings(text);
    expect(settings.waitingNudgeDays).toBe(DEFAULT_SETTINGS.waitingNudgeDays);
    expect(warnings).toEqual([
      'Settings: "Waiting-on nudge after" value "3 weeks" is not a number of days from 1 to 60; using 5 days.',
    ]);
  });

  it('falls back to the default and warns on an out-of-range minute count', () => {
    const text = '- Brief fallback after: 5';
    const { settings, warnings } = parseSettings(text);
    expect(settings.briefFallbackMinutes).toBe(DEFAULT_SETTINGS.briefFallbackMinutes);
    expect(warnings).toEqual([
      'Settings: "Brief fallback after" value "5" is not a number of minutes from 15 to 720; using 90 minutes.',
    ]);
  });

  it('ignores unknown keys', () => {
    const text = ['- Favorite color: blue', '- Brief time: 06:45'].join('\n');
    const { settings, warnings } = parseSettings(text);
    expect(settings.briefTime).toBe('06:45');
    expect(warnings).toEqual([]);
  });

  it('ignores settings-shaped lines inside frontmatter', () => {
    const text = ['---', '- Brief time: 06:00', '---', '# Settings', '- Brief time: 06:45'].join(
      '\n',
    );
    const { settings } = parseSettings(text);
    expect(settings.briefTime).toBe('06:45');
  });

  it('ignores non-list lines and lines inside fenced code blocks', () => {
    const text = [
      '# Settings',
      'Brief time: 06:00',
      '```',
      '- Brief time: 05:00',
      '```',
      '- Brief time: 06:45',
    ].join('\n');
    const { settings } = parseSettings(text);
    expect(settings.briefTime).toBe('06:45');
  });

  it('parses CRLF line endings the same way as LF', () => {
    const text = SEEDED_SETTINGS_MD.replace(/\n/g, '\r\n');
    const { settings, warnings } = parseSettings(text);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });
});

describe('validateSetting', () => {
  it('normalizes H:mm to HH:mm', () => {
    const result = validateSetting('Brief time', '7:30');
    expect(result).toEqual({ ok: true, key: 'Brief time', value: '07:30' });
  });

  it('rejects am/pm forms for time settings', () => {
    const result = validateSetting('Brief time', '8am');
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-range hour', () => {
    const result = validateSetting('Nudge time', '24:00');
    expect(result.ok).toBe(false);
  });

  it('accepts a valid IANA time zone', () => {
    const result = validateSetting('Time zone', 'Europe/London');
    expect(result).toEqual({ ok: true, key: 'Time zone', value: 'Europe/London' });
  });

  it('rejects an unknown time zone', () => {
    const result = validateSetting('Time zone', 'Not/AZone');
    expect(result.ok).toBe(false);
  });

  it('accepts a bare number of days', () => {
    const result = validateSetting('Waiting-on nudge after', '10');
    expect(result).toEqual({ ok: true, key: 'Waiting-on nudge after', value: '10 days' });
  });

  it('accepts "N days" and rejects out-of-range days', () => {
    expect(validateSetting('Waiting-on nudge after', '7 days')).toEqual({
      ok: true,
      key: 'Waiting-on nudge after',
      value: '7 days',
    });
    expect(validateSetting('Waiting-on nudge after', '0').ok).toBe(false);
    expect(validateSetting('Waiting-on nudge after', '61').ok).toBe(false);
  });

  it('accepts "N minutes" and rejects out-of-range minutes', () => {
    expect(validateSetting('Brief fallback after', '120 minutes')).toEqual({
      ok: true,
      key: 'Brief fallback after',
      value: '120 minutes',
    });
    expect(validateSetting('Brief fallback after', '14').ok).toBe(false);
    expect(validateSetting('Brief fallback after', '721').ok).toBe(false);
  });

  it('rejects an unknown setting key', () => {
    const result = validateSetting('Favorite color', 'blue');
    expect(result.ok).toBe(false);
  });

  it('matches keys case-insensitively with extra spacing', () => {
    const result = validateSetting('  brief   time ', '9:05');
    expect(result).toEqual({ ok: true, key: 'Brief time', value: '09:05' });
  });
});

describe('setSettingInText', () => {
  it('edits only the target line, keeping the rest of the file byte-for-byte', () => {
    const updated = setSettingInText(SEEDED_SETTINGS_MD, 'Brief time', '08:00');
    expect(updated).toBe(SEEDED_SETTINGS_MD.replace('- Brief time: 07:30', '- Brief time: 08:00'));
  });

  it('preserves CRLF line endings', () => {
    const crlfText = SEEDED_SETTINGS_MD.replace(/\n/g, '\r\n');
    const updated = setSettingInText(crlfText, 'Nudge time', '10:00');
    expect(updated).toBe(crlfText.replace('- Nudge time: 09:00', '- Nudge time: 10:00'));
    expect(updated.includes('\r\n')).toBe(true);
    expect(updated).not.toMatch(/[^\r]\n/);
  });

  it('preserves a file with no trailing newline', () => {
    const noTrailing = SEEDED_SETTINGS_MD.replace(/\n$/, '');
    const updated = setSettingInText(noTrailing, 'Brief time', '08:00');
    expect(updated).toBe(noTrailing.replace('- Brief time: 07:30', '- Brief time: 08:00'));
  });

  it('preserves indentation and existing spacing around the colon', () => {
    const text = '  -   Brief time:07:30\n';
    const updated = setSettingInText(text, 'Brief time', '08:00');
    expect(updated).toBe('  -   Brief time:08:00\n');
  });

  it('inserts a missing setting line after the last existing setting line', () => {
    const text = [
      '# Settings',
      '',
      '- Time zone: America/Los_Angeles',
      '- Brief time: 07:30',
      '',
    ].join('\n');
    const updated = setSettingInText(text, 'Nudge time', '09:00');
    expect(updated).toBe(
      [
        '# Settings',
        '',
        '- Time zone: America/Los_Angeles',
        '- Brief time: 07:30',
        '- Nudge time: 09:00',
        '',
      ].join('\n'),
    );
  });

  it('inserts a setting at the end when none exist yet', () => {
    const text = '# Settings\n';
    const updated = setSettingInText(text, 'Brief time', '07:30');
    expect(updated).toBe('# Settings\n- Brief time: 07:30');
  });

  it('leaves frontmatter and unrelated lines untouched when editing', () => {
    const updated = setSettingInText(SEEDED_SETTINGS_MD, 'Time zone', 'Europe/Paris');
    expect(updated.startsWith('---\nclaudia: settings\n---\n# Settings\n')).toBe(true);
    expect(updated).toContain('- Time zone: Europe/Paris');
    expect(updated).toContain('- Brief time: 07:30');
  });
});
