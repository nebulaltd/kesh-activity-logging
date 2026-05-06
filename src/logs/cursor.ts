export interface Cursor {
  t: number;
  i: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      't' in parsed &&
      'i' in parsed &&
      typeof (parsed as { t: unknown }).t === 'number' &&
      typeof (parsed as { i: unknown }).i === 'string'
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}
