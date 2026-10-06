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

/* ----------------------------------------------------- library / trail --- */

export const IconLibrary = ({ size = 17, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M2.8 6.4a1.4 1.4 0 0 1 1.4-1.4h4l1.8 2.2h8.8a1.4 1.4 0 0 1 1.4 1.4v9.4a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4V6.4Z" />
  </svg>
);

export const IconFolder = ({ size = 16, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 6.6a1.3 1.3 0 0 1 1.3-1.3h3.5l1.7 2.1h9.2A1.3 1.3 0 0 1 20 8.7v8.9a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 17.6V6.6Z" />
  </svg>
);

export const IconChevron = ({ size = 16, className, open }: P & { open?: boolean }) => (
  <svg
    {...base(size, className)}
    style={{
      transform: open === true ? 'rotate(90deg)' : 'none',
      transition: 'transform var(--dur) var(--ease)',
    }}
  >
    <path d="m9.4 5.6 6.6 6.4-6.6 6.4" />
  </svg>
);

export const IconFilter = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.4 5.4h17.2l-6.6 7.6v6.2l-4 1.6v-7.8L3.4 5.4Z" />
  </svg>
);

export const IconSort = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M4 6.6h11M4 12h7.4M4 17.4h4M16.2 8.6v10.4M13.2 16.2l3 2.8 3-2.8" />
  </svg>
);

export const IconTag = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.6 11V4.6a1 1 0 0 1 1-1H11l9 9-7.4 7.4-9-9Z" />
    <circle cx="7.6" cy="7.6" r="1.4" />
  </svg>
);

export const IconGrip = ({ size = 16, className }: P) => (
  <svg {...base(size, className)} fill="currentColor" stroke="none">
    <circle cx="9.4" cy="5.6" r="1.35" />
    <circle cx="14.6" cy="5.6" r="1.35" />
    <circle cx="9.4" cy="12" r="1.35" />
    <circle cx="14.6" cy="12" r="1.35" />
    <circle cx="9.4" cy="18.4" r="1.35" />
    <circle cx="14.6" cy="18.4" r="1.35" />
  </svg>
);

export const IconDots = ({ size = 15, className }: P) => (
  <svg {...base(size, className)} fill="currentColor" stroke="none">
    <circle cx="12" cy="5.2" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="12" cy="18.8" r="1.6" />
  </svg>
);

export const IconScissors = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="6.2" cy="17.4" r="2.7" />
    <circle cx="6.2" cy="6.6" r="2.7" />
    <path d="M8.5 8 19 18.4M19 5.6 8.5 16" />
  </svg>
);

export const IconChart = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.2 19.2h17.6" />
    <path d="m3.8 15.4 4.4-6.2 3.6 3.6 3.4-6 4.6 8.6" />
  </svg>
);

export const IconPin = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 2.8a5.6 5.6 0 0 1 5.6 5.6c0 4.2-5.6 12-5.6 12S6.4 12.6 6.4 8.4A5.6 5.6 0 0 1 12 2.8Z" />
    <circle cx="12" cy="8.4" r="2" />
  </svg>
);

export const IconEye = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M1.9 12S5.6 5.4 12 5.4 22.1 12 22.1 12 18.4 18.6 12 18.6 1.9 12 1.9 12Z" />
    <circle cx="12" cy="12" r="3.1" />
  </svg>
);

export const IconPlus = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 4.8v14.4M4.8 12h14.4" />
  </svg>
);

export const IconPencil = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4L16.4 3.6Z" />
  </svg>
);

export const IconBack = ({ size = 16, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M19.4 12H4.6M10.6 5.8 4.4 12l6.2 6.2" />
  </svg>
);

export const IconCheck = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m4.8 12.6 4.6 4.6L19.2 6.8" />
  </svg>
);

export const IconMountain = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m2.4 19.2 6.4-11 4 6.4 2.4-3.6 6.4 8.2H2.4Z" />
  </svg>
);

export const IconShoe = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 16.8c0-1.6.6-2.6 2-3.4l3.2-1.9 1.6 1.7 2.3-1.4 1.5 1.7 2.4-1.4c2.5-.2 4.8 1.4 5 3.6.1 1.4-.9 2.5-2.3 2.5H4.6A1.6 1.6 0 0 1 3 16.8Z" />
    <path d="M8.2 11.5 6.6 8.2M11.4 12.8 9.9 9.6M15.2 14.5l-1.4-3" />
  </svg>
);

export const IconHeart = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M12 20.2 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13L12 20.2Z" />
  </svg>
);
