import { describe, expect, it } from 'vitest';
import {
  findDoneAction,
  findLineByBlockId,
  hasReminderField,
  isLineDone,
  parseNtfyMessages,
  rewriteOrigin,
  type NtfyMessage,
} from '../../../scripts/smoke.ts';

describe('rewriteOrigin', () => {
  it('replaces scheme and host:port but keeps path, query and hash', () => {
    const result = rewriteOrigin(
      'https://claudia.aroopbiswal.com/a/abc123?x=1#frag',
      'http://127.0.0.1:8787',
    );
    expect(result).toBe('http://127.0.0.1:8787/a/abc123?x=1#frag');
  });

  it('works when the source URL has no port and the target does', () => {
    const result = rewriteOrigin('https://claudia.aroopbiswal.com/a/xyz', 'http://127.0.0.1:8787');
    expect(result).toBe('http://127.0.0.1:8787/a/xyz');
  });

  it('leaves an already-loopback URL pointed at the same origin', () => {
    const result = rewriteOrigin('http://127.0.0.1:8787/a/xyz', 'http://127.0.0.1:8787');
    expect(result).toBe('http://127.0.0.1:8787/a/xyz');
  });
});

describe('parseNtfyMessages', () => {
  it('parses JSON-lines and keeps only "message" events', () => {
    const body = [
      '{"id":"1","time":100,"event":"open","topic":"t"}',
      '{"id":"2","time":101,"event":"message","topic":"t","message":"hi"}',
      '',
      '{"id":"3","time":102,"event":"keepalive","topic":"t"}',
    ].join('\n');

    const messages = parseNtfyMessages(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('2');
    expect(messages[0]?.message).toBe('hi');
  });

  it('skips malformed lines rather than throwing', () => {
    const body = ['not json', '{"id":"2","time":1,"event":"message","topic":"t"}'].join('\n');
    const messages = parseNtfyMessages(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('2');
  });

  it('returns an empty array for an empty body', () => {
    expect(parseNtfyMessages('')).toEqual([]);
  });
});

describe('findDoneAction', () => {
  function message(actions: NtfyMessage['actions']): NtfyMessage {
    return { id: 'm1', time: 1, event: 'message', topic: 't', actions };
  }

  it('finds an http action labeled Done whose url contains /a/', () => {
    const msg = message([
      { action: 'view', label: 'Open', url: 'obsidian://open?vault=Claudia' },
      {
        action: 'http',
        label: 'Done',
        url: 'https://claudia.aroopbiswal.com/a/tok123',
        method: 'POST',
      },
      {
        action: 'http',
        label: '+1 hour',
        url: 'https://claudia.aroopbiswal.com/a/tok456',
        method: 'POST',
      },
    ]);
    const action = findDoneAction(msg);
    expect(action?.url).toBe('https://claudia.aroopbiswal.com/a/tok123');
  });

  it('is case-insensitive on the label', () => {
    const msg = message([{ action: 'http', label: 'done', url: 'https://x/a/1' }]);
    expect(findDoneAction(msg)?.url).toBe('https://x/a/1');
  });

  it('returns undefined when there is no Done action', () => {
    const msg = message([{ action: 'http', label: '+1 hour', url: 'https://x/a/2' }]);
    expect(findDoneAction(msg)).toBeUndefined();
  });

  it('ignores a Done-labeled action that is not an http action or has no /a/ url', () => {
    const msg = message([
      { action: 'view', label: 'Done', url: 'https://x/not-an-action-link' },
      { action: 'http', label: 'Done' },
    ]);
    expect(findDoneAction(msg)).toBeUndefined();
  });

  it('returns undefined when there are no actions at all', () => {
    expect(findDoneAction(message(undefined))).toBeUndefined();
  });
});

describe('findLineByBlockId', () => {
  const content = [
    '# To do',
    '',
    '- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k',
    '- [ ] Laundry ⏰ 2026-09-27 19:00 ^t2b7m',
  ].join('\n');

  it('finds the line ending with the given block id', () => {
    const line = findLineByBlockId(content, 't9x2k');
    expect(line).toBe('- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k');
  });

  it('returns undefined when no line ends with that id', () => {
    expect(findLineByBlockId(content, 'tnope')).toBeUndefined();
  });

  it('does not match an id that is only a prefix of another id', () => {
    const withSimilar = content + '\n- [ ] Something ^t9x2kx';
    const line = findLineByBlockId(withSimilar, 't9x2k');
    expect(line).toBe('- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k');
  });

  it('tolerates trailing whitespace after the block id', () => {
    const withTrailing = '- [ ] Something ⏰ 2026-09-29 09:00 ^tabcd   ';
    expect(findLineByBlockId(withTrailing, 'tabcd')).toBe(withTrailing);
  });
});

describe('hasReminderField', () => {
  it('is true when the line has a ⏰ field', () => {
    expect(hasReminderField('- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k')).toBe(true);
  });

  it('is false otherwise', () => {
    expect(hasReminderField('- [ ] Renew passport 📅 2026-11-01 ^t8c1d')).toBe(false);
  });
});

describe('isLineDone', () => {
  it('is true for a completed line with [x] and a ✅ date', () => {
    expect(isLineDone('- [x] Call the dentist ⏰ 2026-09-29 09:00 ✅ 2026-09-29 ^t9x2k')).toBe(
      true,
    );
  });

  it('is true for an uppercase [X]', () => {
    expect(isLineDone('- [X] Call the dentist ✅ 2026-09-29 ^t9x2k')).toBe(true);
  });

  it('is false for an open line', () => {
    expect(isLineDone('- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k')).toBe(false);
  });

  it('is false when [x] is present but there is no ✅ date', () => {
    expect(isLineDone('- [x] Call the dentist ^t9x2k')).toBe(false);
  });
});
