/**
 * The shared icon set plus a few the phone needs and the desktop doesn't (system share, camera,
 * favourites, offline). Same 24-unit grid and stroke as Icons.tsx.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icons";

const EXTRA = {
  share: (
    <>
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  "star-fill": <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" />,
  camera: (
    <>
      <path d="M4 8a2 2 0 0 1 2-2h1.5l1.5-2h6l1.5 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </>
  ),
  open: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  photos: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 16l-5-5-8.5 8.5" />
    </>
  ),
  "wifi-off": (
    <>
      <path d="M3 3l18 18" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.7-1.9" />
      <path d="M2 9.3a15 15 0 0 1 4.3-2.7M22 9.3A15 15 0 0 0 10.7 5.1" />
      <circle cx="12" cy="19.5" r="0.6" fill="currentColor" />
    </>
  ),
  "select-drag": (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.4 2.4 4.6-5.4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type MIconName = IconName | keyof typeof EXTRA;

export function MIcon({ name, size = 16, className }: { name: MIconName; size?: number; className?: string }) {
  if (!(name in EXTRA)) return <Icon name={name as IconName} size={size} className={className} />;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {EXTRA[name as keyof typeof EXTRA]}
    </svg>
  );
}
