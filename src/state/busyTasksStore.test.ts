import { act, renderHook } from '@testing-library/react-native';
import { beginBusyTask, useBusyTasks, useBusyTasksStore } from './busyTasksStore';

describe('busyTasksStore', () => {
  beforeEach(() => useBusyTasksStore.setState({ tasks: [] }));

  it('tracks begin → update → finish, and finish is idempotent', () => {
    const slope = beginBusyTask('slope', { now: 100 });
    const pdf = beginBusyTask('pdf', { now: 50, label: 'page 1', progress: { done: 0, total: 3 } });
    expect(useBusyTasksStore.getState().tasks.map((t) => t.kind)).toEqual(['slope', 'pdf']);
    pdf.update({ label: 'page 2', progress: { done: 1, total: 3 } });
    expect(useBusyTasksStore.getState().tasks[1]).toMatchObject({
      label: 'page 2',
      progress: { done: 1 },
    });
    slope.finish();
    slope.finish();
    expect(useBusyTasksStore.getState().tasks.map((t) => t.id)).toEqual([pdf.id]);
    expect(slope.id).not.toBe(pdf.id);
  });

  it('useBusyTasks re-renders with the summary', async () => {
    const { result } = await renderHook(() => useBusyTasks());
    expect(result.current.count).toBe(0);
    let h!: ReturnType<typeof beginBusyTask>;
    await act(async () => {
      h = beginBusyTask('tiles', { now: 5 });
      beginBusyTask('slope', { now: 9 });
    });
    expect(result.current.longest?.kind).toBe('tiles');
    expect(result.current.others).toBe(1);
    await act(async () => h.finish());
    expect(result.current.longest?.kind).toBe('slope');
    expect(result.current.others).toBe(0);
  });
});
