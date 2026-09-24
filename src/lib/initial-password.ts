/**
 * Initial password generator for invited students.
 *
 * SERVER ONLY. Uses node:crypto (CSPRNG). Do not import from client components.
 *
 * The charset excludes visually ambiguous characters
 * (0 O o 1 l I 2 Z z 5 S s) so the password can be read and typed by hand.
 */

import { randomInt } from "node:crypto";

export const INITIAL_PASSWORD_CHARSET =
  "ABCDEFGHJKLMNPQRTUVWXY" + "abcdefghijkmnpqrtuvwxy" + "346789";

export const MIN_INITIAL_PASSWORD_LENGTH = 12;
export const DEFAULT_INITIAL_PASSWORD_LENGTH = 14;

export function generateInitialPassword(
  length: number = DEFAULT_INITIAL_PASSWORD_LENGTH,
  randomIndex: (max: number) => number = (max) => randomInt(max)
): string {
  if (!Number.isInteger(length) || length < MIN_INITIAL_PASSWORD_LENGTH) {
    throw new Error(
      `Initial password length must be an integer >= ${MIN_INITIAL_PASSWORD_LENGTH}.`
    );
  }

  // randomIndex(max) returns an unbiased integer in [0, max). Do not use `%`
  // to map random values onto the charset (modulo bias).
  let password = "";
  for (let i = 0; i < length; i++) {
    password += INITIAL_PASSWORD_CHARSET[randomIndex(INITIAL_PASSWORD_CHARSET.length)];
  }
  return password;
}
