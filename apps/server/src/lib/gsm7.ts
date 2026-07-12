/**
 * GSM-7 sanitisation.
 *
 * RouterOS `/tool sms send` only supports the GSM 7-bit alphabet, and it does
 * not fail loudly on anything else — it *silently drops* the offending
 * characters. A German user reported sending "Hellö!" and the recipient
 * receiving "Hell!". For a Finnish alert like "Vesivuoto keittiössä" that would
 * mangle the message in exactly the situation where it matters most.
 *
 * We therefore transliterate rather than trust the modem: ä→a, ö→o, å→a and so
 * on, then drop anything still outside a conservative safe set. Losing the
 * diacritics is a small price; losing letters is not.
 *
 * We are deliberately stricter than the GSM 03.38 spec allows. The spec does
 * contain ä/ö/å, but RouterOS demonstrably mishandles them, so we do not rely
 * on it.
 */

/** Characters we are confident survive the RouterOS → modem → handset path. */
const SAFE =
  "@$\n\r !\"#%&'()*+,-./0123456789:;<=>?" +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  '_';

const SAFE_SET = new Set(SAFE.split(''));

/** Transliterations applied before the safe-set filter. */
const TRANSLITERATE: Record<string, string> = {
  // Nordic / Finnish
  ä: 'a', Ä: 'A', ö: 'o', Ö: 'O', å: 'a', Å: 'A',
  æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O',
  // Common European
  é: 'e', è: 'e', ê: 'e', ë: 'e', É: 'E', È: 'E',
  á: 'a', à: 'a', â: 'a', Á: 'A', À: 'A',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u', Ü: 'U',
  ñ: 'n', Ñ: 'N', ç: 'c', Ç: 'C', ß: 'ss',
  // Punctuation that word processors and humans introduce without noticing
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00A0': ' ',
  '\u20AC': 'EUR', '\u00B0': ' deg',
};

/**
 * Converts arbitrary text into something RouterOS can transmit intact.
 * Unknown characters (emoji, CJK, box drawing…) are replaced with '?' rather
 * than removed, so the recipient can see that something was lost instead of
 * reading a subtly corrupted sentence.
 */
export function toGsm7(input: string): string {
  let out = '';
  for (const ch of input) {
    const mapped = TRANSLITERATE[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (SAFE_SET.has(ch)) {
      out += ch;
      continue;
    }
    out += '?';
  }
  return out;
}

/** True if the text passes through toGsm7 unchanged. */
export function isGsm7Safe(input: string): boolean {
  return toGsm7(input) === input;
}

/**
 * Sanitises and truncates to a single SMS segment. GSM-7 fits 160 characters;
 * we sanitise first because transliteration can change the length (ß→ss).
 */
export function toGsm7Sms(input: string, maxLength = 160): string {
  const clean = toGsm7(input);
  if (clean.length <= maxLength) return clean;
  if (maxLength <= 3) return clean.slice(0, maxLength);
  return clean.slice(0, maxLength - 3) + '...';
}
