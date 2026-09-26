// Vault layout constants and path helpers (vault-format.md section 1).

export const LAYOUT = {
  todo: 'Tasks/To do.md',
  followUps: 'Tasks/Follow-ups.md',
  appointments: 'Tasks/Appointments.md',
  profile: 'Memory/Profile.md',
  today: 'Today.md',
  recent: 'Recently captured.md',
  readme: '_claudia/README.md',
  settings: '_claudia/Settings.md',
  rules: '_claudia/Rules.md',
} as const;

const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** Display name -> safe note-name stem (vault-format.md section 1). */
export function sanitizeNoteName(name: string): string {
  const cleaned = name.replace(FORBIDDEN_NAME_CHARS, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}

export function doneNotePath(yyyyMm: string): string {
  return `Tasks/Done/${yyyyMm}.md`;
}

export function personNotePath(name: string): string {
  return `People/${sanitizeNoteName(name)}.md`;
}

export function topicNotePath(topic: string): string {
  return `Memory/Topics/${sanitizeNoteName(topic)}.md`;
}

export function logNotePath(date: string): string {
  return `Log/${date}.md`;
}

/** Vault-relative POSIX path -> file basename without the .md extension. */
export function noteBasename(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1] ?? path;
  return last.endsWith('.md') ? last.slice(0, -3) : last;
}

function cleanLinkLabel(label: string): string {
  return label.replace(/\r\n|\r|\n/g, ' ').replace(/[|\]]/g, '');
}

export function wikiLink(path: string, blockId?: string, label?: string): string {
  const base = noteBasename(path);
  let target = base;
  if (blockId) target += `#^${blockId}`;
  if (label !== undefined && label !== '') {
    target += `|${cleanLinkLabel(label)}`;
  }
  return `[[${target}]]`;
}

export function obsidianUri(vaultName: string, path: string, blockId?: string): string {
  const filePart = blockId ? `${path}#^${blockId}` : path;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePart)}`;
}

/** Claudia indexes Markdown anywhere except .obsidian/, .trash/ and dot-folders. */
export function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  const dirs = segments.slice(0, -1);
  return dirs.some((seg) => seg.startsWith('.'));
}

/** Tasks/**, People/**, Memory/** and _claudia/Rules.md get block IDs assigned. */
export function isIdManagedPath(path: string): boolean {
  return (
    path.startsWith('Tasks/') ||
    path.startsWith('People/') ||
    path.startsWith('Memory/') ||
    path === LAYOUT.rules
  );
}

const CONFLICT_COPY_RE = /^(.*) (\d+)\.md$/;

/** `Tasks/To do 2.md` -> `Tasks/To do.md`; null when not a conflict-copy name. */
export function conflictCopyBase(path: string): string | null {
  const m = CONFLICT_COPY_RE.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 2) return null;
  return `${m[1]}.md`;
}
