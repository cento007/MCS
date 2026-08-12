/**
 * Minimal `.env` parser (TDS 02 §8.3 — "parse, merge under real env").
 *
 * Hand-rolled rather than pulled from a dependency because the grammar we need is five
 * lines of spec and the file is read once per process at boot: `KEY=VALUE`, `#` comments,
 * optional `export ` prefix, optional surrounding quotes. No variable expansion, no
 * multiline values, no shell semantics — a bootstrap file is not a script.
 */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const match = LINE.exec(rawLine);
    if (match === null) continue;

    const key = match[1];
    let value = match[2] ?? '';
    if (key === undefined) continue;

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values may carry a trailing `# comment`.
      const hashIndex = value.indexOf(' #');
      if (hashIndex !== -1) value = value.slice(0, hashIndex).trimEnd();
    }

    result[key] = value;
  }

  return result;
}
