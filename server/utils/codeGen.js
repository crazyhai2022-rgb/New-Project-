const { customAlphabet } = require('nanoid');

// No ambiguous characters (0/O, 1/I/L) — this code gets read aloud and typed
// on phones, so it needs to survive both.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generate = customAlphabet(ALPHABET, 6);

/** A 6-character code guaranteed not to collide with a currently-live session. */
function generateSessionCode(existsFn) {
  let code;
  do {
    code = generate();
  } while (existsFn(code));
  return code;
}

module.exports = { generateSessionCode };
