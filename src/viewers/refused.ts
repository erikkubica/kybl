/**
 * What the Office previews say when `zipTooBig` refused a file. Two causes read differently:
 * a file that is too big once unpacked, or laid out in an unusual way (REFUSED), and one that is
 * simply broken, like a download cut short (DAMAGED), so neither is called the other.
 */
export const REFUSED = "refused";
export const DAMAGED = "damaged";
export const REFUSED_TEXT = "This file is too big, or built in a way the preview can't safely open. Use “Open in another app” instead.";
export const DAMAGED_TEXT = "This file looks damaged or incomplete, so it can't be opened. Try downloading it again, or use “Open in another app”.";

/** The reasons `zipTooBig` gives that mean the zip itself is broken rather than too big. */
const BROKEN = ["bad local header", "part runs past the end", "unreadable zip"];

/** Whether the bytes start like a zip but no end record exists anywhere: a cut-short download. */
function cutShort(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return false;
  }
  return true;
}

/** REFUSED or DAMAGED, for the `why` a refused file came back with. */
export function refusalKind(why: string, bytes: Uint8Array): typeof REFUSED | typeof DAMAGED {
  return BROKEN.includes(why) || (why === "unusual zip layout" && cutShort(bytes)) ? DAMAGED : REFUSED;
}
