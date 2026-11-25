/**
 * The Kybl mark: the enamel bucket without the face (brand book, "Mark"). Below 24 px the dots
 * drop away and only the silhouette is left. `sun` is the red-on-yellow version used for the paid
 * Kybl Storage offer.
 */
export function KyblMark({ size = 32, sun, className }: { size?: number; sun?: boolean; className?: string }) {
  const line = "#1e1a1a";
  const dots = size >= 24;
  return (
    <svg className={`km ${sun ? "km-sun" : ""} ${className ?? ""}`} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path d="M14 25 C14 3 50 3 50 25" fill="none" stroke={line} strokeWidth="4.4" strokeLinecap="round" className="km-line" />
      <rect x="24" y="5" width="16" height="7" rx="3.5" fill={sun ? "#fff" : "#ffc93c"} />
      <path d="M12 25 L17.5 54 A14.5 4.5 0 0 0 46.5 54 L52 25 Z" fill="#d9381f" />
      <ellipse cx="32" cy="25" rx="22.5" ry="7.2" fill={line} className="km-rim" />
      <ellipse cx="32" cy="25" rx="17.5" ry="3.9" fill="#8f1f0c" />
      {dots && (
        <g fill="#fff">
          <circle cx="23" cy="40" r="3" />
          <circle cx="41" cy="40" r="3" />
          <circle cx="32" cy="49" r="3" />
        </g>
      )}
    </svg>
  );
}

/** Mark and the lowercase wordmark in Fredoka, side by side. */
export function KyblLockup({ size = 20 }: { size?: number }) {
  return (
    <span className="kybl-lockup" style={{ "--lock": `${size}px` } as React.CSSProperties}>
      <KyblMark size={size} />
      <span className="kybl-wordmark">kybl</span>
    </span>
  );
}
