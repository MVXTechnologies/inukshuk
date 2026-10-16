import { DEFAULT_WAYPOINT_ICON_LABEL } from '@core/library/waypointIcons';
import type { WaypointIcon } from '@core/models';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@ui/paper';

import { mciGlyph } from '../components/waypointGlyph';
import { useScaledStyles } from '@ui/displayScale';

interface Props {
  /** `undefined` = the default inukshuk pin. */
  icon: WaypointIcon | undefined;
  label: string;
  selected: boolean;
  width: number;
  onPress: (icon: WaypointIcon | undefined) => void;
  /** Starred (#675 favourites): a small star on the tile. */
  favorite?: boolean;
  /** Long-press stars/unstars; omitted where starring is not offered. */
  onToggleFavorite?: (icon: WaypointIcon) => void;
}

/**
 * One icon choice (#675): glyph over its name, selected = filled with the
 * sheet accent. A radio for screen readers, with "star" as a named action
 * where favourites are offered (the long-press is not discoverable by touch
 * alone, so the picker also says so in a hint line).
 */
export const IconTile = memo(function IconTile({
  icon,
  label,
  selected,
  width,
  onPress,
  favorite = false,
  onToggleFavorite,
}: Props) {
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  const tokens = useSchemeTokens();
  const glyph = mciGlyph(icon);
  const ink = selected ? theme.colors.onSecondary : tokens.ink;
  const canStar = onToggleFavorite !== undefined && icon !== undefined;
  const starLabel = favorite ? 'Remove from favourites' : 'Add to favourites';
  return (
    <Pressable
      onPress={() => onPress(icon)}
      onLongPress={canStar ? () => onToggleFavorite(icon) : undefined}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={favorite ? 'Favourite' : undefined}
      accessibilityState={{ checked: selected, selected }}
      accessibilityActions={canStar ? [{ name: 'longpress', label: starLabel }] : undefined}
      onAccessibilityAction={
        canStar
          ? (e) => {
              if (e.nativeEvent.actionName === 'longpress') onToggleFavorite(icon);
            }
          : undefined
      }
      style={({ pressed }) => [
        styles.tile,
        { width },
        selected && { backgroundColor: theme.colors.secondary },
        pressed && !selected && { backgroundColor: tokens.surfaceVariant },
      ]}
    >
      <View>
        {glyph === null ? (
          <InukshukGlyph size={26} frame="square" tone="mono" color={ink} />
        ) : (
          <MaterialCommunityIcons name={glyph} size={26} color={ink} />
        )}
        {favorite && (
          <View
            style={[styles.star, { backgroundColor: theme.colors.surface }]}
            testID={`favorite-${icon ?? 'default'}`}
          >
            <MaterialCommunityIcons name="star" size={11} color={palette.ochre} />
          </View>
        )}
      </View>
      <Text
        numberOfLines={2}
        style={[styles.label, { color: selected ? theme.colors.onSecondary : tokens.inkVariant }]}
        maxFontSizeMultiplier={1.3}
      >
        {icon === undefined ? DEFAULT_WAYPOINT_ICON_LABEL : label}
      </Text>
    </Pressable>
  );
});

export const ICON_TILE_HEIGHT = 70;

const stylesSheet = StyleSheet.create({
  tile: {
    height: ICON_TILE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 2,
    borderRadius: 12,
  },
  label: { fontSize: 10.5, lineHeight: 12, textAlign: 'center' },
  star: {
    position: 'absolute',
    right: -8,
    top: -5,
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
