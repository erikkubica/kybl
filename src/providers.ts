/**
 * Visual identity for each connection provider (sidebar badges, the connection dialog). Badges are
 * a plain monogram on the service's colour, never a brand logo; the service's name sits next to it.
 */
export type ProviderMeta = { id: string; short: string; mono: string; color: string };

/** The S3-compatible presets, in the order the S3 form offers them ("custom" last). */
export const PROVIDERS: ProviderMeta[] = [
  { id: "kybl", short: "Kybl Storage", mono: "K", color: "#ffc93c" },
  { id: "hetzner", short: "Hetzner", mono: "H", color: "#e0243c" },
  { id: "aws", short: "Amazon S3", mono: "S3", color: "#f08c00" },
  { id: "r2", short: "Cloudflare R2", mono: "R2", color: "#f4731f" },
  { id: "b2", short: "Backblaze B2", mono: "B2", color: "#d9342b" },
  { id: "wasabi", short: "Wasabi", mono: "W", color: "#12b24a" },
  { id: "do", short: "DigitalOcean", mono: "DO", color: "#1a7bff" },
  { id: "custom", short: "Other", mono: "S3", color: "#7c8494" },
];

/** The other connection kinds; `provider` of their profiles is the kind's id. */
export const OTHER_PROVIDERS: ProviderMeta[] = [
  { id: "gdrive", short: "Google Drive", mono: "GD", color: "#1e8e3e" },
  { id: "onedrive", short: "OneDrive", mono: "OD", color: "#0a6cc4" },
  { id: "dropbox", short: "Dropbox", mono: "DB", color: "#2d5bd8" },
  { id: "webdav", short: "WebDAV", mono: "DAV", color: "#7a5bd0" },
  { id: "sftp", short: "SFTP", mono: "SSH", color: "#1f8a70" },
  { id: "ftp", short: "FTP", mono: "FTP", color: "#a46a1f" },
  { id: "azblob", short: "Azure Blob", mono: "AZ", color: "#0b84d6" },
  { id: "gcs", short: "Cloud Storage", mono: "GCS", color: "#3b74e0" },
  { id: "box", short: "Box", mono: "BX", color: "#1f6fd1" },
  { id: "local", short: "This device", mono: "", color: "#7c8494" },
];

const ALL = [...PROVIDERS, ...OTHER_PROVIDERS];
const OTHER = PROVIDERS.find((p) => p.id === "custom")!;

export function providerMeta(id: string | undefined): ProviderMeta {
  return ALL.find((p) => p.id === id) ?? OTHER;
}
