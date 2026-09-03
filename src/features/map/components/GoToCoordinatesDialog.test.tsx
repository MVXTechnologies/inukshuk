import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { GoToCoordinatesDialog } from './GoToCoordinatesDialog';

/**
 * The parsing itself is covered in `@core/geo/parseCoords`. What this covers
 * is the dialog's own decision table, which is where a coordinate box goes
 * wrong in practice:
 *
 * - "Go" is only live for a coordinate that actually parsed,
 * - "Set destination" ALSO accepts an empty box, meaning the map centre,
 * - a coordinate that does not parse arms neither, and says so.
 */
const QC = { latitude: 46.8139, longitude: -71.2082 };

// `render` resolves asynchronously here (React 19 act); awaiting it is what
// populates `screen`, exactly as MapOverlaysMenu.test.tsx does.
async function setup(center: typeof QC | null = QC) {
  const handlers = {
    onDismiss: jest.fn(),
    onGo: jest.fn(),
    onSetDestination: jest.fn(),
    onCopy: jest.fn(),
  };
  await render(
    <PaperProvider>
      <GoToCoordinatesDialog center={center} {...handlers} />
    </PaperProvider>,
  );
  return handlers;
}

// Typing re-parses and re-renders; the act() wrapper is what flushes that
// before the assertions look at the buttons' enabled state.
const type = async (text: string): Promise<void> => {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Go to coordinates'), text);
  });
};

describe('GoToCoordinatesDialog', () => {
  it('reads the map centre out in all three notations', async () => {
    await setup();
    await screen.findByText('46.81390, -71.20820');
    expect(screen.getByText("46°48.834'N, 71°12.492'W")).toBeOnTheScreen();
    expect(screen.getByText('46°48\'50.0"N, 71°12\'29.5"W')).toBeOnTheScreen();
  });

  it('copies the line you tap', async () => {
    const handlers = await setup();
    await screen.findByText('46.81390, -71.20820');
    fireEvent.press(screen.getByLabelText('Copy deg / min'));
    expect(handlers.onCopy).toHaveBeenCalledWith("46°48.834'N, 71°12.492'W");
  });

  it('goes to a coordinate that parses', async () => {
    const handlers = await setup();
    await screen.findByText('Go');
    await type('46°48\'50"N 71°12\'29"W');
    fireEvent.press(screen.getByText('Go'));
    expect(handlers.onGo).toHaveBeenCalledTimes(1);
    const [at] = handlers.onGo.mock.calls[0] as [typeof QC];
    // Whole seconds ≈ 30 m, which is the tolerance the notation itself carries.
    expect(at.latitude).toBeCloseTo(46.8139, 3);
    expect(at.longitude).toBeCloseTo(-71.2082, 3);
  });

  it('refuses garbage instead of guessing, and says why', async () => {
    const handlers = await setup();
    await screen.findByText('Go');
    await type('somewhere over there');
    expect(screen.getByText(/Not a coordinate we can read/)).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Go'));
    fireEvent.press(screen.getByText('Set destination'));
    expect(handlers.onGo).not.toHaveBeenCalled();
    expect(handlers.onSetDestination).not.toHaveBeenCalled();
  });

  it('will not "go" nowhere with an empty box', async () => {
    const handlers = await setup();
    await screen.findByText('Go');
    fireEvent.press(screen.getByText('Go'));
    expect(handlers.onGo).not.toHaveBeenCalled();
  });

  it('sets the destination on the map centre when the box is empty', async () => {
    const handlers = await setup();
    await screen.findByText('Set destination');
    fireEvent.press(screen.getByText('Set destination'));
    expect(handlers.onSetDestination).toHaveBeenCalledWith(QC);
  });

  it('has nothing to offer before the camera has settled', async () => {
    const handlers = await setup(null);
    await screen.findByText('Waiting for the map to settle…');
    fireEvent.press(screen.getByText('Set destination'));
    expect(handlers.onSetDestination).not.toHaveBeenCalled();
  });
});
