import {
  finishBusyTask,
  startBusyTask,
  summarizeBusy,
  updateBusyTask,
  type BusyTasks,
} from './busyTasks';

describe('busy tasks registry', () => {
  const empty: BusyTasks = [];

  it('starts, updates and finishes tasks', () => {
    let s = startBusyTask(empty, { id: 'a', kind: 'slope', startedAt: 10 });
    s = startBusyTask(s, { id: 'b', kind: 'pdf', startedAt: 20, label: 'page 1' });
    s = updateBusyTask(s, 'b', { label: 'page 2', progress: { done: 1, total: 4 } });
    expect(s).toEqual([
      { id: 'a', kind: 'slope', startedAt: 10 },
      { id: 'b', kind: 'pdf', startedAt: 20, label: 'page 2', progress: { done: 1, total: 4 } },
    ]);
    s = finishBusyTask(s, 'a');
    expect(s.map((t) => t.id)).toEqual(['b']);
  });

  it('re-starting an id replaces it; finished tasks are not resurrected by updates', () => {
    let s = startBusyTask(empty, { id: 'a', kind: 'tiles', startedAt: 1 });
    s = startBusyTask(s, { id: 'a', kind: 'tiles', startedAt: 5 });
    expect(s).toHaveLength(1);
    expect(s[0]!.startedAt).toBe(5);
    s = finishBusyTask(s, 'a');
    expect(updateBusyTask(s, 'a', { label: 'x' })).toBe(s);
    expect(finishBusyTask(s, 'a')).toBe(s);
  });

  it('summarizes: the longest-running task, "+N" others, the kinds present', () => {
    expect(summarizeBusy(empty)).toEqual({ count: 0, longest: null, others: 0, kinds: [] });
    let s = startBusyTask(empty, { id: 'p', kind: 'pdf', startedAt: 300 });
    s = startBusyTask(s, { id: 's', kind: 'slope', startedAt: 100 });
    s = startBusyTask(s, { id: 'c', kind: 'contours', startedAt: 200 });
    s = startBusyTask(s, { id: 'p2', kind: 'pdf', startedAt: 400 });
    const sum = summarizeBusy(s);
    expect(sum.longest?.id).toBe('s');
    expect(sum.count).toBe(4);
    expect(sum.others).toBe(3);
    expect(sum.kinds).toEqual(['pdf', 'slope', 'contours']);
  });
});
