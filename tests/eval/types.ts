export type Category =
  | 'personal'
  | 'appointment'
  | 'follow_up'
  | 'people'
  | 'profile'
  | 'coding'
  | 'learning'
  | 'voice'
  | 'nosave'
  | 'rule'
  | 'sensitive'
  | 'mixed';

export interface ExpectedItem {
  kind: 'task' | 'follow_up' | 'appointment' | 'fact';
  /** All of these words (case-insensitive, substring on word stems is fine) must appear in the
   * saved item's text (or person for follow-ups/facts). */
  match: string[];
  /** Time expression (docs/tools.md) resolved at case start, e.g. 'tuesday 09:00', 'tomorrow 18:00', '+2h', 'today 20:00'. */
  remind?: string;
  /** Default 0 for absolute forms; relative (+Nm/+Nh) default 3. */
  remindToleranceMin?: number;
  /** Date expression, e.g. 'friday'. */
  due?: string;
  /** Time expression for the appointment start. */
  appointmentStart?: string;
  /** For follow_up / fact about a person. */
  person?: string;
  direction?: 'waiting' | 'promised';
  /** Substring expected in the repeat rule, e.g. 'week'. */
  repeat?: string;
}

export interface EvalCase {
  id: string;
  category: Category;
  message: string;
  setup?: { rules?: Array<{ text: string; keywords: string[] }> };
  /** [] means nothing should be saved. */
  expect: ExpectedItem[];
  /** Words that must not appear in any saved item. */
  forbid?: string[];
  notes?: string;
}

export interface SavedItem {
  kind: string;
  text: string;
  person: string | null;
  people: string[];
  direction: string | null;
  reminderLocal: string | null;
  due: string | null;
  appointmentStart: string | null;
  repeat: string | null;
  path: string;
}

export interface CaseRun {
  caseId: string;
  startedAt: Date;
  saved: SavedItem[];
  rulesAdded: number;
  error?: string;
}
