import { describe, expect, it } from 'vitest';
import { extractItems } from '../../../src/vault/items.ts';
import { isInCodeFence, parseNote } from '../../../src/vault/note.ts';

describe('isInCodeFence: an unbalanced fence marker', () => {
  it('documents current behaviour: an unclosed ``` fence swallows every following line for the rest of the note', () => {
    const text = [
      '# Notes',
      '',
      '```',
      'someone forgot to close this fence',
      '',
      '- [ ] A perfectly ordinary real task ⏰ 2026-09-29 09:00 ^t9x2k',
      '',
      '- [ ] Another real task ^t1a1a',
    ].join('\n');

    const note = parseNote(text);
    const flags = isInCodeFence(note);

    // The fence-open line itself is flagged, and (with no closing fence) every subsequent line,
    // including two lines that are plainly ordinary tasks, is flagged too.
    expect(flags[2]).toBe(true); // ```
    expect(flags[5]).toBe(true); // the real task line
    expect(flags[7]).toBe(true); // the second real task line
  });

  it('BUG (documented, not fixed here): a stray unclosed fence earlier in a real vault note silently drops every task after it from the index', () => {
    // Minimal repro of realistic item loss: someone pastes a code snippet into Tasks/To do.md
    // and forgets the closing ``` (or a stray ``` appears anywhere for any reason). Every task
    // below it -- even ones with nothing to do with the snippet -- silently stops being indexed,
    // with no error surfaced anywhere. This is out of scope to fix here: the fix would live in
    // isInCodeFence / extractItems (src/vault/note.ts, src/vault/items.ts), which are not in the
    // set of files this task is allowed to modify. Reported for a maintainer to pick up.
    const text = [
      '# To do',
      '',
      '- [ ] Task before the snippet ^t0000',
      '',
      'Pasted from the terminal:',
      '```',
      'npm run build',
      '',
      '- [ ] Task written days later, unrelated to the snippet ⏰ 2026-10-01 09:00 ^t1111',
      '- [ ] Yet another real task ^t2222',
    ].join('\n');

    const note = parseNote(text);
    const items = extractItems('Tasks/To do.md', note);

    // Only the task before the stray fence is extracted; the two real tasks after it vanish from
    // the index even though nothing about them is inside a real code block from the author's
    // point of view (the fence was never closed, so structurally everything after it forever
    // counts as "inside").
    expect(items.map((i) => i.id)).toEqual(['t0000']);
  });
});
