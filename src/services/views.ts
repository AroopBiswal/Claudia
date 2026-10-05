import type { ItemKind, ItemStatus, VaultItem } from '../vault/items.ts';
import { obsidianUri } from '../vault/layout.ts';

/** The item shape every tool returns (docs/tools.md, recall result). */
export interface ItemView {
  id: string | null;
  kind: ItemKind;
  status: ItemStatus;
  text: string;
  note: string;
  reminder: string | null;
  snoozed_until: string | null;
  due: string | null;
  appointment: string | null;
  repeat: string | null;
  expires: string | null;
  created: string | null;
  stale: boolean;
  tags: string[];
  people: string[];
  link: string;
}

/** Anything item-like the views can render: a vault item plus the index's resolved people. */
export type ViewableItem = VaultItem & { effectiveReminder?: string | null };

export function formatAppointment(a: VaultItem['appointment']): string | null {
  if (!a) return null;
  return a.end ? `${a.date} ${a.start}-${a.end}` : `${a.date} ${a.start}`;
}

export function itemView(item: ViewableItem, opts: { vaultName: string; today: string }): ItemView {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    text: item.text,
    note: item.path,
    reminder: item.reminder,
    snoozed_until: item.snooze,
    due: item.due,
    appointment: formatAppointment(item.appointment),
    repeat: item.repeat,
    expires: item.expires,
    created: item.created,
    stale: item.kind === 'fact' && item.expires !== null && item.expires < opts.today,
    tags: item.tags,
    people: item.people,
    link: obsidianUri(opts.vaultName, item.path, item.id ?? undefined),
  };
}

/** One short line for text content blocks, e.g. "Call the dentist (⏰ 2026-09-29 09:00) [t9x2k]". */
export function itemLine(item: ViewableItem): string {
  const bits: string[] = [];
  const reminder = item.effectiveReminder ?? item.reminder;
  if (reminder) bits.push(`⏰ ${reminder}`);
  const appt = formatAppointment(item.appointment);
  if (appt) bits.push(`🗓️ ${appt}`);
  if (item.due) bits.push(`📅 ${item.due}`);
  if (item.repeat) bits.push(`🔁 ${item.repeat}`);
  if (item.status !== 'open') bits.push(item.status);
  const suffix = bits.length > 0 ? ` (${bits.join(', ')})` : '';
  const id = item.id ? ` [${item.id}]` : '';
  return `${item.text}${suffix}${id}`;
}
