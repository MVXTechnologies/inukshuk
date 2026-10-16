/**
 * React Native Paper at the Display size (#760). The app imports Paper from
 * here, never from `react-native-paper` directly (eslint enforces it): Paper
 * scales its text from the theme (`theme.ts` › `scaleTheme`), but it bakes
 * its paddings, icon sizes and row heights into its own StyleSheets. These
 * wrappers pass those sizes in, scaled, as the style props Paper merges last.
 *
 * At 100 % every wrapper renders the Paper component with the caller's props
 * untouched, so the default layout is exactly Paper's.
 *
 * Touch areas: a wrapper never takes a pressable below where Paper puts it
 * at 100 % on the axis that matters (List rows and menu items keep 48 dp,
 * icon buttons a 48 dp box, buttons a 48 dp hitSlop); the visuals shrink.
 */
import {
  MIN_TOUCH,
  hitSlopFor,
  osFontCap,
  scaleFontSize,
  scaleSize,
  scaleSpacing,
} from '@core/display/displayScale';
import { forwardRef, type ComponentProps, type ComponentRef } from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import {
  ActivityIndicator as PaperActivityIndicator,
  Button as PaperButton,
  Chip as PaperChip,
  Icon as PaperIcon,
  IconButton as PaperIconButton,
  List as PaperList,
  Menu as PaperMenu,
  SegmentedButtons as PaperSegmentedButtons,
  Text as PaperText,
} from 'react-native-paper';

import { useDisplayFactor } from './displayScale';

export * from 'react-native-paper';

type IconSource = ComponentProps<typeof PaperIcon>['source'];
type IconRenderProps = { size: number; color: string };

/**
 * An icon source Paper draws at its own built-in size (18 in buttons, 24 in
 * menus), redrawn at the Display size. A function source is the caller's own
 * drawing, which renders this module's Icon and so scales itself: it passes
 * through, or it would be scaled twice.
 */
export function scaledIconSource(source: IconSource, factor: number): IconSource {
  if (factor === 1 || source === undefined || source === null) return source;
  if (typeof source === 'function') return source;
  return ((p: IconRenderProps) => (
    <PaperIcon source={source} size={scaleSize(p.size, factor)} color={p.color} />
  )) as IconSource;
}

// ---------------------------------------------------------------- Text

/**
 * Paper's Text with the combined cap (owner 2026-10-16): at Large the OS
 * font scale is held so Display size x OS font stays within today's caps
 * (the caller's, else 1.3); unchanged at Small and Default.
 */
function ScaledText(props: ComponentProps<typeof PaperText>) {
  const k = useDisplayFactor();
  if (!(k > 1)) return <PaperText {...props} />;
  return (
    <PaperText
      {...props}
      maxFontSizeMultiplier={osFontCap(k, props.maxFontSizeMultiplier ?? undefined)}
    />
  );
}
export const Text = ScaledText as typeof PaperText;

// ---------------------------------------------------------------- Icon

export function Icon(props: ComponentProps<typeof PaperIcon>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperIcon {...props} />;
  return <PaperIcon {...props} size={scaleSize(props.size, k)} />;
}

export function ActivityIndicator(props: ComponentProps<typeof PaperActivityIndicator>) {
  const k = useDisplayFactor();
  if (k === 1 || typeof props.size !== 'number') return <PaperActivityIndicator {...props} />;
  return <PaperActivityIndicator {...props} size={scaleSize(props.size, k)} />;
}

// ---------------------------------------------------------------- IconButton

/** Paper's MD3 icon button: a box of size + 2 × 8, with a 6 dp margin. */
const ICON_PAD = 8;
const ICON_MARGIN = 6;

/**
 * The box and margin of an icon button of icon `size` at `factor`: the box
 * (Paper's touch area) never below 48 dp once scaled away from 100 %; the
 * margin gives back what the floor added, so the footprint shrinks with the
 * icon until it reaches 48.
 */
export function iconButtonBox(size: number, factor: number): { box: number; margin: number } {
  const visual = scaleSize(size, factor) + 2 * scaleSpacing(ICON_PAD, factor);
  const box = Math.max(MIN_TOUCH, visual);
  const margin = Math.max(0, (visual + 2 * scaleSpacing(ICON_MARGIN, factor) - box) / 2);
  return { box, margin };
}

export const IconButton = forwardRef<
  ComponentRef<typeof PaperIconButton>,
  ComponentProps<typeof PaperIconButton>
>(function IconButton(props, ref) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperIconButton ref={ref} {...props} />;
  const size = props.size ?? 24;
  const { box, margin } = iconButtonBox(size, k);
  return (
    <PaperIconButton
      ref={ref}
      {...props}
      size={scaleSize(size, k)}
      style={[{ width: box, height: box, borderRadius: box / 2, margin }, props.style]}
    />
  );
});

// ---------------------------------------------------------------- Button

/** Paper MD3 button: a 20 dp label line with 10 dp above and below (40 dp). */
const BUTTON_LINE = 20;
const BUTTON_PAD = 10;

/** A Paper button's drawn height at `factor`: its label line plus its padding. */
export function buttonHeight(factor: number): number {
  return scaleSize(BUTTON_LINE, factor) + 2 * scaleSpacing(BUTTON_PAD, factor);
}

/**
 * Paper's button is drawn 40 dp tall (less at Small): a vertical hitSlop
 * takes its touch area to 48 dp at every size (#760). A caller's own hitSlop
 * wins.
 */
export function buttonHitSlop(factor: number): { top: number; bottom: number } {
  const slop = hitSlopFor(buttonHeight(factor));
  return { top: slop, bottom: slop };
}

export const Button = forwardRef<
  ComponentRef<typeof PaperButton>,
  ComponentProps<typeof PaperButton>
>(function Button(props, ref) {
  const k = useDisplayFactor();
  const hitSlop = props.hitSlop ?? buttonHitSlop(k);
  if (k === 1) return <PaperButton ref={ref} {...props} hitSlop={hitSlop} />;
  const text = props.mode === undefined || props.mode === 'text';
  const label: TextStyle = {
    marginVertical: scaleSpacing(BUTTON_PAD, k),
    marginHorizontal: scaleSpacing(text ? 12 : 24, k),
  };
  return (
    <PaperButton
      ref={ref}
      {...props}
      hitSlop={hitSlop}
      maxFontSizeMultiplier={osFontCap(k, props.maxFontSizeMultiplier ?? undefined)}
      icon={scaledIconSource(props.icon, k)}
      labelStyle={[label, props.labelStyle]}
    />
  );
});

// ---------------------------------------------------------------- Chip

export function Chip(props: ComponentProps<typeof PaperChip>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperChip {...props} />;
  return (
    <PaperChip
      {...props}
      icon={scaledIconSource(props.icon, k)}
      textStyle={[{ marginVertical: scaleSpacing(6, k) }, props.textStyle]}
    />
  );
}

// ---------------------------------------------------------------- SegmentedButtons

type SegmentedProps = ComponentProps<typeof PaperSegmentedButtons>;
/** A segment's drawn height at `factor`: Paper's 9 dp padding (as spacing) around a 20 dp line. */
export function segmentHeight(factor: number): number {
  return scaleSize(20, factor) + 2 * scaleSpacing(9, factor);
}

export function SegmentedButtons(props: SegmentedProps) {
  const k = useDisplayFactor();
  // Drawn 38 dp tall at 100 % (less at Small): a vertical hitSlop takes each
  // segment's touch area to 48 dp at every size (#760). A caller's wins.
  const slop = hitSlopFor(segmentHeight(k));
  // Paper spreads each button's props onto its SegmentedButtonItem, which takes
  // hitSlop and labelMaxFontSizeMultiplier; the button type just omits them.
  type Extra = { hitSlop?: unknown; labelMaxFontSizeMultiplier?: number };
  const buttons = props.buttons.map((b: SegmentedProps['buttons'][number] & Extra) => ({
    ...b,
    hitSlop: b.hitSlop ?? { top: slop, bottom: slop },
    ...(k === 1
      ? null
      : {
          icon: scaledIconSource(b.icon, k),
          // Paper pads the content 9 dp; the label's own margin takes up the rest.
          labelStyle: [
            { marginVertical: scaleSpacing(9, k) - 9 } satisfies TextStyle,
            b.labelStyle,
          ] as StyleProp<TextStyle>,
          labelMaxFontSizeMultiplier: osFontCap(k, b.labelMaxFontSizeMultiplier),
        }),
  }));
  return <PaperSegmentedButtons {...({ ...props, buttons } as SegmentedProps)} />;
}

// ---------------------------------------------------------------- List

type ItemProps = ComponentProps<typeof PaperList.Item>;
const ListItem = forwardRef<ComponentRef<typeof PaperList.Item>, ItemProps>(
  function ListItem(props, ref) {
    const k = useDisplayFactor();
    if (k === 1) return <PaperList.Item ref={ref} {...props} />;
    const pressable = props.onPress !== undefined || props.onLongPress !== undefined;
    return (
      <PaperList.Item
        ref={ref}
        {...props}
        style={[
          {
            paddingVertical: scaleSpacing(8, k),
            paddingRight: scaleSpacing(24, k),
            ...(pressable ? { minHeight: MIN_TOUCH } : null),
          },
          props.style,
        ]}
        containerStyle={[{ marginVertical: scaleSpacing(6, k) }, props.containerStyle]}
        contentStyle={[{ paddingLeft: scaleSpacing(16, k) }, props.contentStyle]}
        titleStyle={[{ fontSize: scaleFontSize(16, k) }, props.titleStyle]}
        descriptionStyle={[{ fontSize: scaleFontSize(14, k) }, props.descriptionStyle]}
        titleMaxFontSizeMultiplier={osFontCap(k, props.titleMaxFontSizeMultiplier)}
        descriptionMaxFontSizeMultiplier={osFontCap(k, props.descriptionMaxFontSizeMultiplier)}
      />
    );
  },
);

function ListIcon(props: ComponentProps<typeof PaperList.Icon>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperList.Icon {...props} />;
  return <PaperList.Icon {...props} icon={scaledIconSource(props.icon, k)} />;
}

function ListAccordion(props: ComponentProps<typeof PaperList.Accordion>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperList.Accordion {...props} />;
  return (
    <PaperList.Accordion
      {...props}
      style={[
        {
          paddingVertical: scaleSpacing(8, k),
          paddingRight: scaleSpacing(24, k),
          minHeight: MIN_TOUCH,
        },
        props.style,
      ]}
      titleStyle={[{ fontSize: scaleFontSize(16, k) }, props.titleStyle]}
      descriptionStyle={[{ fontSize: scaleFontSize(14, k) }, props.descriptionStyle]}
    />
  );
}

function ListSubheader(props: ComponentProps<typeof PaperList.Subheader>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperList.Subheader {...props} />;
  return (
    <PaperList.Subheader
      {...props}
      style={[
        { paddingHorizontal: scaleSpacing(16, k), paddingVertical: scaleSpacing(13, k) },
        props.style,
      ]}
    />
  );
}

export const List = {
  ...PaperList,
  Item: ListItem,
  Icon: ListIcon,
  Accordion: ListAccordion,
  Subheader: ListSubheader,
};

// ---------------------------------------------------------------- Menu

function MenuItem(props: ComponentProps<typeof PaperMenu.Item>) {
  const k = useDisplayFactor();
  if (k === 1) return <PaperMenu.Item {...props} />;
  return (
    <PaperMenu.Item
      {...props}
      leadingIcon={scaledIconSource(props.leadingIcon, k)}
      trailingIcon={scaledIconSource(props.trailingIcon, k)}
      titleStyle={[{ fontSize: scaleFontSize(16, k) }, props.titleStyle]}
      titleMaxFontSizeMultiplier={osFontCap(k, props.titleMaxFontSizeMultiplier)}
    />
  );
}

function MenuBase(props: ComponentProps<typeof PaperMenu>) {
  return <PaperMenu {...props} />;
}
export const Menu = Object.assign(MenuBase, { Item: MenuItem });
