import { timeOfDay, timeOfDayForHour } from './timeOfDay';

describe('timeOfDayForHour', () => {
  const expected = [
    ...Array<string>(5).fill('Night'), // 0–4
    ...Array<string>(7).fill('Morning'), // 5–11
    ...Array<string>(5).fill('Afternoon'), // 12–16
    ...Array<string>(4).fill('Evening'), // 17–20
    ...Array<string>(3).fill('Night'), // 21–23
  ];

  it.each(expected.map((label, hour) => [hour, label]))('hour %i is %s', (hour, label) => {
    expect(timeOfDayForHour(hour as number)).toBe(label);
  });

  it('covers every hour of the day', () => {
    expect(expected).toHaveLength(24);
  });

  it('never calls the small hours "Afternoon" (2.5.2 QA: a 4 a.m. start)', () => {
    for (let h = 0; h < 5; h++) expect(timeOfDayForHour(h)).toBe('Night');
  });
});

describe('timeOfDay', () => {
  it('reads the local hour of a timestamp', () => {
    expect(timeOfDay(new Date(2026, 9, 14, 4, 59).getTime())).toBe('Night');
    expect(timeOfDay(new Date(2026, 9, 14, 5, 0).getTime())).toBe('Morning');
    expect(timeOfDay(new Date(2026, 9, 14, 0, 0).getTime())).toBe('Night');
    expect(timeOfDay(new Date(2026, 9, 14, 12, 0).getTime())).toBe('Afternoon');
    expect(timeOfDay(new Date(2026, 9, 14, 20, 59).getTime())).toBe('Evening');
  });
});
