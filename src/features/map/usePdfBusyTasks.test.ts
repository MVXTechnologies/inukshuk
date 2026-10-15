import { useBusyTasksStore } from '@state/busyTasksStore';
import { useLibraryStore } from '@state/libraryStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { act, renderHook } from '@testing-library/react-native';
import { usePdfBusyTasks } from './usePdfBusyTasks';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

/** #721 — the PDF "Rendering… page N" rows became 'pdf' busy tasks. */
const maps = [
  { id: 'a', name: 'Charlevoix', activePages: [0, 1] },
  { id: 'b', name: 'Nord', activePages: [0] },
];

beforeEach(() => {
  useBusyTasksStore.setState({ tasks: [] });
  useOverlayStatusStore.setState({ statuses: {} });
  useLibraryStore.setState({ maps: maps as never });
});

const pdfTasks = () =>
  useBusyTasksStore
    .getState()
    .tasks.filter((t) => t.kind === 'pdf')
    .map((t) => `${t.subject} ${t.label}`);

it('a page in the rasterizer is a task until it is drawn, fails or leaves', async () => {
  const view = await renderHook(usePdfBusyTasks);
  expect(pdfTasks()).toEqual([]);
  await act(async () =>
    useOverlayStatusStore.setState({
      statuses: {
        'a:1': { phase: 'rendering' },
        'b:0': { phase: 'rendering' },
        'a:0': { phase: 'preparing' }, // a background pre-render is no wait for the map
      },
    }),
  );
  expect(pdfTasks()).toEqual(['Charlevoix p.2', 'Nord p.1']);
  const firstId = useBusyTasksStore.getState().tasks[0]!.id;
  // Another status changes: the running ones keep their task (and start time).
  await act(async () =>
    useOverlayStatusStore.setState((s) => ({
      statuses: { ...s.statuses, 'b:0': { phase: 'rendered' } },
    })),
  );
  expect(pdfTasks()).toEqual(['Charlevoix p.2']);
  expect(useBusyTasksStore.getState().tasks[0]!.id).toBe(firstId);
  await act(async () =>
    useOverlayStatusStore.setState({ statuses: { 'a:1': { phase: 'failed', reason: 'x' } } }),
  );
  expect(pdfTasks()).toEqual([]);
  await view.unmount();
});

it('leaving the map finishes its tasks', async () => {
  useOverlayStatusStore.setState({ statuses: { 'a:0': { phase: 'rendering' } } });
  const view = await renderHook(usePdfBusyTasks);
  expect(pdfTasks()).toEqual(['Charlevoix p.1']);
  await view.unmount();
  expect(pdfTasks()).toEqual([]);
});
