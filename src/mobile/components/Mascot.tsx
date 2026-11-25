import "@fontsource/fredoka/latin-700.css";

/*
 * Brand book (notes/brand/kybl-brand.html): the rim and handle line is cast iron (#1e1a1a) and
 * flips to chipped enamel (#f1efed) on dark surfaces, via --k-line in mobile.css. Kyblík (with a
 * face) is for empty states and welcomes; toolbars get the plain mark next to the "kybl"
 * wordmark in Fredoka.
 */

/** Kyblík, the brand mascot (same drawing as src-tauri/icons/src/mascot.svg). */
export function Mascot({ size = 64, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`m-mascot ${className}`} viewBox="0 0 200 200" width={size} height={size} aria-hidden="true">
      <path d="M40 76 C40 6 160 6 160 76" fill="none" stroke="var(--k-line)" strokeWidth="7" strokeLinecap="round" />
      <rect x="80" y="16" width="40" height="15" rx="7.5" fill="#ffc93c" />
      <rect x="86" y="19" width="22" height="3.4" rx="1.7" fill="#fff" opacity="0.45" />
      <path d="M38 76 L54 168 A46 12 0 0 0 146 168 L162 76 A62 16 0 0 1 38 76 Z" fill="#d9381f" />
      <path d="M149 100 L139 162" fill="none" stroke="#000" strokeOpacity="0.12" strokeWidth="13" strokeLinecap="round" />
      <path d="M52 100 L57 130" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="5" strokeLinecap="round" />
      <path d="M54 168 A46 12 0 0 0 146 168" fill="none" stroke="var(--k-line)" strokeWidth="4.5" strokeLinecap="round" />
      <ellipse cx="100" cy="76" rx="66" ry="18" fill="var(--k-line)" />
      <ellipse cx="100" cy="76" rx="56" ry="11.5" fill="#8f1f0c" />
      <path d="M44 70 A60 14 0 0 1 78 60" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="2.6" strokeLinecap="round" />
      <g fill="#fff">
        {[
          [62, 106],
          [138, 106],
          [66, 134],
          [134, 134],
          [76, 157],
          [100, 163],
          [124, 157],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="5.2" />
        ))}
      </g>
      <ellipse cx="85" cy="114" rx="8.5" ry="10" fill="#fff" />
      <ellipse cx="115" cy="114" rx="8.5" ry="10" fill="#fff" />
      <circle cx="86.5" cy="116" r="5" fill="#1e1a1a" />
      <circle cx="116.5" cy="116" r="5" fill="#1e1a1a" />
      <circle cx="88.4" cy="113.8" r="1.8" fill="#fff" />
      <circle cx="118.4" cy="113.8" r="1.8" fill="#fff" />
      <path d="M89 133 Q100 144 111 133" fill="none" stroke="#1e1a1a" strokeWidth="4.2" strokeLinecap="round" />
    </svg>
  );
}

/** The plain mark for small sizes: bolder lines, three dots, no face (website/assets/mark.svg). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="m-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path d="M14 25 C14 3 50 3 50 25" fill="none" stroke="var(--k-line)" strokeWidth="4.4" strokeLinecap="round" />
      <rect x="24" y="5" width="16" height="7" rx="3.5" fill="#ffc93c" />
      <path d="M12 25 L17.5 54 A14.5 4.5 0 0 0 46.5 54 L52 25 Z" fill="#d9381f" />
      <ellipse cx="32" cy="25" rx="22.5" ry="7.2" fill="var(--k-line)" />
      <ellipse cx="32" cy="25" rx="17.5" ry="3.9" fill="#8f1f0c" />
      <g fill="#fff">
        <circle cx="23" cy="40" r="3" />
        <circle cx="41" cy="40" r="3" />
        <circle cx="32" cy="49" r="3" />
      </g>
    </svg>
  );
}

/** Mark + wordmark, as in the brand book's lockup. */
export function Lockup({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`m-lockup ${className}`} role="img" aria-label="Kybl">
      <BrandMark size={size} />
      <span className="m-wordmark" style={{ fontSize: Math.round(size * 1.1) }} aria-hidden="true">
        kybl
      </span>
    </span>
  );
}
