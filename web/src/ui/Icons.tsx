/**
 * Inline SVG icons — no icon font, no sprite sheet, no dependency.
 * All drawn on a 24-box, 1.7 stroke, round caps, so they sit as one family.
 */

type P = { size?: number; className?: string };

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...(className === undefined ? {} : { className }),
});

export const IconInukshuk = ({ size = 17, className }: P) => (
  // The app's mark, reduced to its silhouette: legs, arms, cap.
  <svg {...base(size, className)} fill="currentColor" stroke="none">
    <rect x="4.6" y="4" width="14.8" height="2.7" rx="1" />
    <rect x="6.6" y="8" width="3.4" height="4.4" rx="1" />
    <rect x="14" y="8" width="3.4" height="4.4" rx="1" />
    <rect x="10.4" y="8.6" width="3.2" height="3.2" rx="0.9" />
    <rect x="6.9" y="13.6" width="3.6" height="6.4" rx="1" />
    <rect x="13.5" y="13.6" width="3.6" height="6.4" rx="1" />
  </svg>
);

export const IconSun = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const IconMoon = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z" />
  </svg>
);

export const IconLayers = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m12 2.7 9 4.8-9 4.8-9-4.8 9-4.8Z" />
    <path d="m3 12.5 9 4.8 9-4.8M3 17.2l9 4.8 9-4.8" />
  </svg>
);

export const IconMap = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m9 4.2 6 2.6 5.2-2.3v13l-5.2 2.3-6-2.6-5.2 2.3v-13L9 4.2Z" />
    <path d="M9 4.2v13M15 6.8v13" />
  </svg>
);

export const IconRoute = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="5.5" r="2.5" />
    <path d="M8 18.5h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6" />
  </svg>
);

export const IconSearch = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="10.8" cy="10.8" r="6.8" />
    <path d="m20 20-4.4-4.4" />
  </svg>
);

export const IconPlay = ({ size = 15, className }: P) => (
  <svg {...base(size, className)} fill="currentColor" stroke="none">
    <path d="M8.5 5.4 18.6 12 8.5 18.6V5.4Z" />
  </svg>
);

export const IconPause = ({ size = 15, className }: P) => (
  <svg {...base(size, className)} fill="currentColor" stroke="none">
    <rect x="7.4" y="5.4" width="3.6" height="13.2" rx="1.2" />
    <rect x="13" y="5.4" width="3.6" height="13.2" rx="1.2" />
  </svg>
);

export const IconClose = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m5.6 5.6 12.8 12.8M18.4 5.6 5.6 18.4" />
  </svg>
);

export const IconSlash = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m6.4 6.4 11.2 11.2" />
  </svg>
);

export const IconTarget = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="7.4" />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 1.8v2.6M12 19.6v2.6M22.2 12h-2.6M4.4 12H1.8" />
  </svg>
);

export const IconTrash = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M4.4 6.6h15.2M9.4 6.6V4.8a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8" />
    <path d="M6.6 6.6 7.5 19a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.4" />
  </svg>
);

export const IconDownload = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 3.6v11M7.6 10.6 12 15l4.4-4.4M4.4 19.2h15.2" />
  </svg>
);

export const IconSpinner = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 3.4a8.6 8.6 0 1 1-6.1 2.5" />
  </svg>
);
