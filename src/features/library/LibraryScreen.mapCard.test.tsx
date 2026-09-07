/**
 * The Library map card's "Overlay pages" block, at the real call site (#236).
 *
 * The shipped bug was iOS-only and invisible to any test that asserted on
 * `activePages` alone: Paper's default Checkbox is platform-adaptive, and its
 * iOS variant renders the checkmark at `opacity: 0` when unchecked — so on an
 * iPhone an inactive page showed NO control at all, only a stranded "Page N"
 * label, and a page toggled off could never be toggled back on. Hence
 * "imported PDFs have no checkbox to show their pages as an overlay".
 *
 * So these tests pin four things: one checkbox per georeferenced page, each
 * carrying its real checked state; that an UNCHECKED box is actually drawn
 * (the regression itself); the explanatory line for a PDF with no
 * georeferencing; and that toggling a page writes `activePages`.
 */
import type { GeoReference, MapDocument } from '@core/models';
import { NO_GEOREFERENCE_NOTICE } from '@core/library/overlayPages';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
}));
jest.mock('@features/library/importMap', () => ({ pickAndImportMaps: jest.fn() }));
jest.mock('@features/library/importGpx', () => ({ pickAndImportGpxFiles: jest.fn() }));

const geo = (pageIndex: number, size = 600): GeoReference => ({
  pageIndex,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: size, y1: size },
    corners: {
      topLeft: [-71.3, 46.9],
      topRight: [-71.2, 46.9],
      bottomRight: [-71.2, 46.8],
      bottomLeft: [-71.3, 46.8],
    },
  },
  bbox: { minLng: -71.3, minLat: 46.8, maxLng: -71.2, maxLat: 46.9 },
});

const mapDoc = (over: Partial<MapDocument>): MapDocument => ({
  id: 'm1',
  name: 'Sheet',
  fileUri: 'file://m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  ...over,
});

async function show(map: MapDocument): Promise<RenderResult> {
  useLibraryStore.setState({
    hydrated: true,
    maps: [map],
    tracks: [],
    folders: [],
    waypoints: [],
    activeTrackIds: [],
    customCategories: [],
  });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <LibraryScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

/** Press one labelled element and let React 19's async act flush the update. */
async function press(view: RenderResult, label: string) {
  await act(async () => {
    fireEvent.press(view.getByLabelText(label));
  });
}

/** Expand the card's overlay-page list (the chevron beside the map's name). */
const expandOverlayPages = (view: RenderResult) => press(view, 'Overlay pages');

type Rendered = { props?: Record<string, unknown>; children?: unknown[] };

/** The rendered subtree of the element carrying `label`, or null. */
function subtreeOf(node: unknown, label: string): Rendered | null {
  if (node === null || typeof node !== 'object') return null;
  const n = node as Rendered;
  if (n.props?.accessibilityLabel === label) return n;
  for (const child of n.children ?? []) {
    const found = subtreeOf(child, label);
    if (found) return found;
  }
  return null;
}

const activePagesOf = (id: string) =>
  useLibraryStore.getState().maps.find((m) => m.id === id)?.activePages;

it('renders one checkbox per georeferenced page, in a state the user can see', async () => {
  const view = await show(
    mapDoc({ pageCount: 3, georeferences: [geo(0), geo(1), geo(2)], activePages: [0, 2] }),
  );
  await expandOverlayPages(view);

  expect(view.getAllByRole('checkbox')).toHaveLength(3);
  expect(view.getByLabelText('Page 1')).toBeChecked();
  expect(view.getByLabelText('Page 2')).not.toBeChecked();
  expect(view.getByLabelText('Page 3')).toBeChecked();
});

it('draws the box of an UNCHECKED page instead of an invisible one', async () => {
  // The regression, pinned: Paper's iOS checkbox renders its glyph wrapper at
  // `opacity: 0` when unchecked, so the row showed nothing to tap. The
  // Material box (mode="android") draws an empty square in that state — on
  // both platforms.
  const view = await show(mapDoc({ pageCount: 1, georeferences: [geo(0)], activePages: [] }));
  await expandOverlayPages(view);

  const box = subtreeOf(view.toJSON(), 'Page 1');
  expect(box).not.toBeNull();
  expect(JSON.stringify(box)).not.toMatch(/"opacity":0[,}]/);
});

it('counts one checkbox per PAGE, not per viewport, on a multi-viewport sheet', async () => {
  // A US Topo sheet: map frame + locator inset + adjoining-sheet diagram, all
  // on page 0.
  const view = await show(
    mapDoc({ georeferences: [geo(0, 600), geo(0, 140), geo(0, 90)], activePages: [0] }),
  );
  await expandOverlayPages(view);
  expect(view.getAllByRole('checkbox')).toHaveLength(1);
});

it('explains an ungeoreferenced PDF instead of showing an empty section', async () => {
  const view = await show(mapDoc({ name: 'Scanned leaflet', georeferences: [], activePages: [] }));
  expect(view.getByText(NO_GEOREFERENCE_NOTICE)).toBeOnTheScreen();
  // Nothing to expand: there is no page that could ever be drawn.
  expect(view.queryByLabelText('Overlay pages')).toBeNull();
  expect(view.queryAllByRole('checkbox')).toHaveLength(0);
});

it('toggling a page updates activePages', async () => {
  const view = await show(
    mapDoc({ pageCount: 2, georeferences: [geo(0), geo(1)], activePages: [0, 1] }),
  );
  await expandOverlayPages(view);

  await press(view, 'Page 2');
  expect(activePagesOf('m1')).toEqual([0]);

  await press(view, 'Page 2');
  expect(activePagesOf('m1')).toEqual([0, 1]);
});
