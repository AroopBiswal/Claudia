// Lossless Markdown note model: parse and serialize preserve every byte,
// including BOM, per-line EOL style, and the presence or absence of a final
// newline. No I/O here — callers own reading/writing files.

export interface NoteLine {
  text: string;
  eol: '\n' | '\r\n' | ''; // '' only for a last line without a trailing newline
}

export interface Note {
  bom: boolean;
  lines: NoteLine[];
  frontmatter: { endLine: number; claudia: string | null } | null;
}

function splitLines(body: string): NoteLine[] {
  const lines: NoteLine[] = [];
  let idx = 0;
  while (idx <= body.length) {
    const newlineIdx = body.indexOf('\n', idx);
    if (newlineIdx === -1) {
      if (idx < body.length) {
        lines.push({ text: body.slice(idx), eol: '' });
      }
      break;
    }
    if (newlineIdx > idx && body[newlineIdx - 1] === '\r') {
      lines.push({ text: body.slice(idx, newlineIdx - 1), eol: '\r\n' });
    } else {
      lines.push({ text: body.slice(idx, newlineIdx), eol: '\n' });
    }
    idx = newlineIdx + 1;
  }
  return lines;
}

const FRONTMATTER_CLAUDIA_RE = /^claudia:\s*(\S+)/;

export function parseNote(text: string): Note {
  let bom = false;
  let body = text;
  if (body.startsWith('﻿')) {
    bom = true;
    body = body.slice(1);
  }

  const lines = splitLines(body);

  let frontmatter: Note['frontmatter'] = null;
  if (lines.length > 0 && lines[0]?.text === '---') {
    for (let i = 1; i < lines.length; i++) {
      const lineText = lines[i]?.text;
      if (lineText === '---' || lineText === '...') {
        let claudia: string | null = null;
        for (let j = 1; j < i; j++) {
          const match = FRONTMATTER_CLAUDIA_RE.exec(lines[j]?.text ?? '');
          if (match) {
            claudia = match[1] ?? null;
            break;
          }
        }
        frontmatter = { endLine: i, claudia };
        break;
      }
    }
  }

  return { bom, lines, frontmatter };
}

export function serializeNote(note: Note): string {
  let out = note.bom ? '﻿' : '';
  for (const line of note.lines) {
    out += line.text + line.eol;
  }
  return out;
}

export function noteEol(note: Note): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (const line of note.lines) {
    if (line.eol === '\r\n') crlf++;
    else if (line.eol === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function isInCodeFence(note: Note): boolean[] {
  const result: boolean[] = [];
  let inFence = false;
  for (const line of note.lines) {
    const isFenceLine = FENCE_RE.test(line.text);
    if (isFenceLine) {
      result.push(true);
      inFence = !inFence;
    } else {
      result.push(inFence);
    }
  }
  return result;
}
