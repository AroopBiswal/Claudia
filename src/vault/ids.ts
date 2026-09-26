// Block ID generation (vault-format.md section 6): one kind letter plus
// 4 characters from [a-z0-9], regenerated on collision.

export type IdKind = 't' | 'a' | 'f' | 'r';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_ATTEMPTS = 1000;

export function newBlockId(
  kind: IdKind,
  taken: (id: string) => boolean,
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let id = kind;
    for (let i = 0; i < 4; i++) {
      const idx = Math.floor(random() * ID_CHARS.length);
      id += ID_CHARS[idx];
    }
    if (!taken(id)) return id;
  }
  throw new Error(`newBlockId: exhausted ${MAX_ATTEMPTS} attempts for kind "${kind}"`);
}
