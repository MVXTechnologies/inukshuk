import type { CalendarDayEntry } from '@core/dashboard/aggregate';
import { findCategory, type CustomCategory } from '@core/library/categories';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Badge, Icon, IconButton, Text, useTheme } from 'react-native-paper';

/**
 * The dashboard's month calendar: Monday-first grid where every day with an
 * activity shows its (first) category icon; multi-activity days add a count
 * badge. Tapping an active day reports its entry (the screen routes to the
 * trail or opens the picker). Chevrons page months within [oldest, current].
 */

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function MonthCalendar({
  year,
  month,
  entries,
  customCategories,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onDayPress,
}: {
  year: number;
  /** 0-based month. */
  month: number;
  entries: readonly CalendarDayEntry[];
  customCategories: readonly CustomCategory[];
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  onDayPress: (entry: CalendarDayEntry) => void;
}) {
  const theme = useTheme();
  const byDay = useMemo(() => new Map(entries.map((e) => [e.day, e])), [entries]);

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Monday-first column of the 1st: getDay() 0=Sun → column 6.
  const firstCol = (new Date(year, month, 1).getDay() + 6) % 7;
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const cellLabel = (day: number, n: number) => {
    const date = new Date(year, month, day).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return `${date}: ${n === 0 ? 'no activities' : n === 1 ? '1 activity' : `${n} activities`}`;
  };

  const cells: (number | null)[] = [
    ...Array.from({ length: firstCol }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}>
      <View style={styles.header}>
        <IconButton
          icon="chevron-left"
          size={20}
          style={styles.chevron}
          disabled={!canPrev}
          onPress={onPrev}
          accessibilityLabel="Previous month"
        />
        <Text variant="titleSmall">{monthLabel}</Text>
        <IconButton
          icon="chevron-right"
          size={20}
          style={styles.chevron}
          disabled={!canNext}
          onPress={onNext}
          accessibilityLabel="Next month"
        />
      </View>

      <View style={styles.grid}>
        {WEEKDAYS.map((w, i) => (
          <View key={`h${i}`} style={styles.cell}>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {w}
            </Text>
          </View>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <View key={`e${i}`} style={styles.cell} />;
          const entry = byDay.get(day);
          const n = entry?.tracks.length ?? 0;
          const first = entry?.tracks[0];
          const category = first ? findCategory(first.category, [...customCategories]) : null;
          const isToday = isThisMonth && today.getDate() === day;
          return (
            <Pressable
              key={day}
              style={[
                styles.cell,
                isToday && { borderColor: theme.colors.outline, borderWidth: 1.5, borderRadius: 8 },
              ]}
              disabled={!entry}
              onPress={() => entry && onDayPress(entry)}
              accessibilityRole={entry ? 'button' : undefined}
              accessibilityLabel={cellLabel(day, n)}
            >
              <Text
                variant="labelMedium"
                style={{ color: entry ? theme.colors.onSurface : theme.colors.onSurfaceVariant }}
              >
                {day}
              </Text>
              <View style={styles.iconSlot}>
                {entry && (
                  <>
                    <Icon
                      source={category?.icon ?? 'circle-medium'}
                      size={16}
                      color={category?.color ?? theme.colors.onSurfaceVariant}
                    />
                    {n > 1 && (
                      <Badge
                        size={14}
                        style={[styles.badge, { backgroundColor: theme.colors.primary }]}
                      >
                        {n}
                      </Badge>
                    )}
                  </>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 10, paddingBottom: 8, paddingTop: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  chevron: { margin: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    minHeight: 44,
    alignItems: 'center',
    paddingTop: 4,
  },
  iconSlot: { height: 18, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -4, right: -12 },
});
