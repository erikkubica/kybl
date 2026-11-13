/** Visual identity for each connection provider (sidebar badges, the connection dialog). */
export type ProviderMeta = { id: string; short: string; mono: string; color: string };

export const PROVIDERS: ProviderMeta[] = [
  { id: "kybl", short: "Kybl Storage", mono: "K", color: "#d9381f" },
  { id: "hetzner", short: "Hetzner", mono: "H", color: "#e0243c" },
  { id: "aws", short: "Amazon S3", mono: "S3", color: "#f08c00" },
  { id: "r2", short: "Cloudflare R2", mono: "R2", color: "#f4731f" },
  { id: "b2", short: "Backblaze B2", mono: "B2", color: "#d9342b" },
  { id: "wasabi", short: "Wasabi", mono: "W", color: "#12b24a" },
  { id: "do", short: "DigitalOcean", mono: "DO", color: "#1a7bff" },
  { id: "custom", short: "Other", mono: "S3", color: "#7c8494" },
];

export function providerMeta(id: string | undefined): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}
