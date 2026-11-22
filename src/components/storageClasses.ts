/**
 * S3 storage classes with plain names. Providers differ: AWS has all of these, most others
 * accept only STANDARD (and some reject the header entirely), so the editor also takes any
 * custom value the provider documents.
 */
export const STORAGE_CLASSES: { id: string; label: string }[] = [
  { id: "STANDARD", label: "Standard" },
  { id: "INTELLIGENT_TIERING", label: "Intelligent-Tiering" },
  { id: "STANDARD_IA", label: "Infrequent access" },
  { id: "ONEZONE_IA", label: "One zone, infrequent access" },
  { id: "GLACIER_IR", label: "Glacier Instant Retrieval" },
  { id: "GLACIER", label: "Glacier Flexible Retrieval" },
  { id: "DEEP_ARCHIVE", label: "Glacier Deep Archive" },
  { id: "REDUCED_REDUNDANCY", label: "Reduced redundancy" },
];

/** "STANDARD_IA" → "Infrequent access"; unknown classes keep their own name. */
export function storageClassLabel(id: string | null | undefined): string {
  if (!id) return "";
  return STORAGE_CLASSES.find((s) => s.id === id)?.label ?? id;
}
