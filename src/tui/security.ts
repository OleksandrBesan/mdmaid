const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const STRING_CONTROLS = new Set([0x90, 0x98, 0x9e, 0x9f]);

/**
 * Removes terminal control operations from untrusted document content while
 * preserving Markdown line structure. The scanner deliberately avoids running
 * a complex ANSI regular expression over attacker-controlled input.
 */
export function sanitizeTerminalText(value: string): string {
  const input = value.replace(/\r\n?/g, '\n');
  let output = '';
  let index = 0;

  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === ESC) {
      index = skipEscape(input, index + 1);
      continue;
    }
    if (code === CSI) {
      index = skipCsi(input, index + 1);
      continue;
    }
    if (code === OSC) {
      index = skipString(input, index + 1, true);
      continue;
    }
    if (STRING_CONTROLS.has(code)) {
      index = skipString(input, index + 1, false);
      continue;
    }
    if (code === 0x09) {
      output += '    ';
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      output += '\n';
      index += 1;
      continue;
    }
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      index += 1;
      continue;
    }

    output += input[index];
    index += 1;
  }

  return output;
}

function skipEscape(value: string, index: number): number {
  if (index >= value.length) return index;
  const introducer = value.charCodeAt(index);

  if (introducer === 0x5b) return skipCsi(value, index + 1);
  if (introducer === 0x5d) return skipString(value, index + 1, true);
  if ([0x50, 0x58, 0x5e, 0x5f].includes(introducer)) {
    return skipString(value, index + 1, false);
  }

  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x30 && code <= 0x7e) return cursor + 1;
    if (code < 0x20 || code > 0x2f) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function skipCsi(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) return cursor;
  }
  return cursor;
}

function skipString(
  value: string,
  index: number,
  bellTerminates: boolean,
): number {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if ((bellTerminates && code === BEL) || code === ST) return cursor + 1;
    if (
      code === ESC &&
      cursor + 1 < value.length &&
      value.charCodeAt(cursor + 1) === 0x5c
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return cursor;
}
