// Text typed into an agent's terminal must not carry keystrokes of its own: no escape sequences
// (arrow keys, bracketed-paste end markers, OSC), no control characters (Ctrl-C, Esc, Backspace, Tab),
// and no Enter. Line breaks become spaces; everything else is dropped.

// ESC-introduced sequences: CSI (ESC [ ... final), OSC/DCS/SOS/PM/APC strings (ESC ] P X ^ _ ... BEL or ST),
// then any other two-character ESC sequence. Also the 8-bit C1 forms of CSI and the string introducers.
const ESC_SEQUENCES = new RegExp(
  [
    '\\x1b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\x9b[0-?]*[ -/]*[@-~]', // 8-bit CSI
    '(?:\\x1b[\\]PX^_]|[\\x90\\x98\\x9d\\x9e\\x9f])[\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)', // OSC, DCS, SOS, PM, APC
    '\\x1b[ -/]*[0-~]', // other escapes (ESC c, ESC ( B, ESC 7 ...)
  ].join('|'),
  'g',
);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitizeTyped(text: string): string {
  return text
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ')
    .replace(ESC_SEQUENCES, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '');
}
