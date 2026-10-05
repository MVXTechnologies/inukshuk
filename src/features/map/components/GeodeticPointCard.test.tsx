import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { GEODETIC_CATALOG } from '@core/geodetic/catalog';
import { parseGeodeticFeature, type GeodeticMark } from '@core/geodetic/record';
import { GeodeticPointCard } from './GeodeticPointCard';

const vd = (name: string) => GEODETIC_CATALOG.vdatums.findIndex((v) => v.name === name);

const MARK = parseGeodeticFeature({
  i: 'M15KM007',
  s: GEODETIC_CATALOG.sources.findIndex((s) => s.key === 'qc-mrnf'),
  k: '3d',
  d: 0,
  x: -71.20762704,
  y: 46.81315813,
  H: '51.158',
  hd: vd('CGVD2013'),
  gc: '46° 48\' 47.36926" N, 71° 12\' 27.45735" W',
  g2: 'MTM zone 7 (SCOPQ);250798.875;5186200.480',
}) as GeodeticMark;

// The copied check mark clears on a timer: fake timers, flushed after each test.
beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

async function setup(onConvert: jest.Mock = jest.fn()) {
  const onCopy = jest.fn();
  await render(
    <PaperProvider>
      <GeodeticPointCard
        mark={MARK}
        onOpenLink={jest.fn()}
        onNavigate={jest.fn()}
        onConvert={onConvert}
        onCopy={onCopy}
        onClose={jest.fn()}
      />
    </PaperProvider>,
  );
  return onCopy;
}

describe('GeodeticPointCard copy buttons', () => {
  it('copies each line with its datum / system label, and offers Convert', async () => {
    const onConvert = jest.fn();
    const onCopy = await setup(onConvert);
    fireEvent.press(screen.getByLabelText('Copy coordinates'));
    expect(onCopy).toHaveBeenLastCalledWith(
      '46° 48\' 47.36926" N, 71° 12\' 27.45735" W (NAD83(CSRS) · epoch 1997.0)',
      'coordinates',
    );
    fireEvent.press(screen.getByLabelText('Copy MTM zone 7 (SCOPQ)'));
    expect(onCopy).toHaveBeenLastCalledWith(
      'MTM zone 7 (SCOPQ): E 250798.875 N 5186200.480 (NAD83(CSRS) · epoch 1997.0)',
      'MTM zone 7 (SCOPQ)',
    );
    fireEvent.press(screen.getByLabelText('Copy CGVD2013 height'));
    expect(onCopy).toHaveBeenLastCalledWith('H 51.158 m CGVD2013', 'CGVD2013 height');
    fireEvent.press(screen.getByLabelText('Copy WGS 84 display position'));
    expect(onCopy).toHaveBeenLastCalledWith(
      '46.813158° N, 71.207627° W (≈ WGS 84, display ±2 m)',
      'WGS 84 display position',
    );
    // The bottom row: Convert replaced the copy-all button (owner, 2026-10-05).
    // (One render per file: a second render in this file comes up empty.)
    expect(screen.queryByLabelText('Copy published values')).toBeNull();
    expect(screen.getByText('Datasheet')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Convert M15KM007'));
    expect(onConvert).toHaveBeenCalledTimes(1);
  });
});
