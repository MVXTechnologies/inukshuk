/**
 * The activity glyphs, one per `CategoryDefinition.icon`.
 *
 * `@core/library/categories` names MaterialCommunityIcons glyphs (`hiking`,
 * `run-fast`, `snowshoeing`, …) because that is the icon set the app renders
 * with. The playground has no icon font on purpose — every other icon here is
 * inline SVG — so this module is the one place that translates a glyph NAME
 * into a drawing. The mapping is by name, not by category id, so a new custom
 * category (always `tag`) needs nothing added here.
 *
 * These are family-matched to `Icons.tsx`: 24-box, 1.7 stroke, round caps.
 */

type P = { size?: number; className?: string; color?: string };

const svg = (size: number, color: string | undefined, className: string | undefined) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: color ?? 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...(className === undefined ? {} : { className }),
  'aria-hidden': true,
});

/** A head + limbs figure, shared by walk / run / hiking so the set reads as one. */
const figure = (head: [number, number], body: string) => (
  <>
    <circle cx={head[0]} cy={head[1]} r="1.9" />
    <path d={body} />
  </>
);

const GLYPHS: Record<string, (p: Required<Pick<P, 'size'>> & P) => React.ReactElement> = {
  // Hiker: leaning forward, staff planted ahead.
  hiking: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      {figure([13.2, 4.4], 'M12.6 8.2 10.4 13l2.9 1.9.6 5.4M10.4 13 7.3 16.1M12.6 8.6l3.1 2.1')}
      <path d="M18.4 6.6v13.8" />
    </svg>
  ),
  // Runner: knee up, arms driving.
  run: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      {figure(
        [14.4, 4.6],
        'M13.8 8.4 10.9 12l3.1 2.4-1 6M10.9 12l-3.6 2.6M13.6 8.8l3.7 1.5 1.6 3.1',
      )}
    </svg>
  ),
  // Runner plus motion lines — "trail run" is the same body, moving faster.
  'run-fast': ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      {figure([15.4, 4.6], 'M14.8 8.4 11.9 12l3.1 2.4-1 6M11.9 12l-3.4 2.5M14.6 8.8l3.6 1.5 1.5 3')}
      <path d="M2.4 8.4h4.2M1.4 12h3.6M2.8 15.6h3" opacity="0.75" />
    </svg>
  ),
  bike: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      <circle cx="5.4" cy="16.4" r="3.6" />
      <circle cx="18.6" cy="16.4" r="3.6" />
      <path d="M5.4 16.4 9.6 8.6h3.2l3.1 7.8M9 8.6h4.4M12.8 8.6l2.6 3.4h3" />
      <circle cx="16.6" cy="5.1" r="1.5" />
    </svg>
  ),
  ski: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      {figure([15.6, 4.2], 'M15 7.8 12.2 11l3 2.2-.4 3.4M12.2 11 9.4 12.4M14.8 8.2l3.4 1.6')}
      <path d="M3.4 17.4 20 20.4M4.6 20.4h15.8" />
    </svg>
  ),
  // A snowshoe: teardrop frame with lacing.
  snowshoeing: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      <path d="M12 3.2c3.4 0 5.4 3.1 5.4 7.4 0 4.8-2.2 10.2-5.4 10.2s-5.4-5.4-5.4-10.2c0-4.3 2-7.4 5.4-7.4Z" />
      <path d="M7.4 9h9.2M7 12.6h10M8 16.2h8M12 6.4v12.4" opacity="0.8" />
    </svg>
  ),
  walk: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      {figure([12.6, 4.4], 'M12.2 8.2 10.4 13l2.7 2 .8 5.2M10.4 13l-1.6 4.4M12.4 8.8l3.3 2 .8 3')}
    </svg>
  ),
  // A planned line with a destination pin — the untimed "navigation trail".
  'map-marker-path': ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      <path d="M4.6 19.4c2.6 0 3.4-2.2 3.4-4.4S6.8 10 6.8 7.8" strokeDasharray="2.6 2.4" />
      <circle cx="4.6" cy="19.4" r="1.8" />
      <path d="M16.6 3.2a4.2 4.2 0 0 1 4.2 4.2c0 3.1-4.2 7.2-4.2 7.2s-4.2-4.1-4.2-7.2a4.2 4.2 0 0 1 4.2-4.2Z" />
      <circle cx="16.6" cy="7.4" r="1.5" />
    </svg>
  ),
  'compass-outline': ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m15.4 8.6-2 5.4-5.4 2 2-5.4 5.4-2Z" />
    </svg>
  ),
  // Every custom category.
  tag: ({ size, color, className }) => (
    <svg {...svg(size, color, className)}>
      <path d="M3.6 11V4.6a1 1 0 0 1 1-1H11l9 9-7.4 7.4-9-9Z" />
      <circle cx="7.6" cy="7.6" r="1.4" />
    </svg>
  ),
};

/** Fallback for a glyph name this module has not drawn — a neutral dot ring. */
const Unknown = ({ size, color, className }: Required<Pick<P, 'size'>> & P) => (
  <svg {...svg(size, color, className)}>
    <circle cx="12" cy="12" r="7.6" />
    <circle cx="12" cy="12" r="2.2" />
  </svg>
);

export function CategoryIcon({ icon, size = 18, color, className }: P & { icon: string }) {
  const Glyph = GLYPHS[icon] ?? Unknown;
  return (
    <Glyph
      size={size}
      {...(color === undefined ? {} : { color })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
