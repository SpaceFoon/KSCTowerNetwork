import { z } from "zod";

/**
 * Strip ASCII C0/C1 control characters except for tab/newline/CR. These bytes
 * aren't directly XSS but cause real bugs:
 *   - terminal/log escape sequences (e.g. ANSI colour) when ops `tail -f` logs
 *   - zero-width joiners that defeat moderator search
 *   - DEL (\u007F) and U+0085 NEL that some renderers treat as line breaks
 *
 * We deliberately keep \t (\u0009), \n (\u000A), \r (\u000D) so multi-line
 * report bodies and pasted log snippets survive unchanged.
 */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

export function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHAR_RE, "");
}

/**
 * Zod helper: a length-bounded string that automatically strips control bytes
 * before any `.min()` / `.max()` checks fire. Intended for any user-supplied
 * text that is stored, logged, or rendered.
 */
export function safeStr(max: number) {
  return z
    .string()
    .max(max + 64, { message: `String exceeds ${max} chars even before sanitization` })
    .transform((v) => stripControlChars(v).slice(0, max));
}
