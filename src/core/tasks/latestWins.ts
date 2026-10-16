/**
 * Serialize an expensive async job so at most one runs at a time and only the
 * NEWEST waiting request runs next (#722): panning five times while a slope
 * compute is busy queues one compute, not five. A request superseded while
 * waiting resolves to `null` without running; one already running finishes
 * (it cannot be interrupted) and resolves normally — the caller still checks
 * that its result is current before showing it.
 */
export function latestWins<I, O>(run: (input: I) => Promise<O>): (input: I) => Promise<O | null> {
  let running = false;
  let waiting: {
    input: I;
    resolve: (v: O | null) => void;
    reject: (e: unknown) => void;
  } | null = null;

  const pump = () => {
    if (running || waiting === null) return;
    const job = waiting;
    waiting = null;
    running = true;
    run(job.input)
      .then(job.resolve, job.reject)
      .finally(() => {
        running = false;
        pump();
      });
  };

  return (input) =>
    new Promise<O | null>((resolve, reject) => {
      waiting?.resolve(null); // superseded before it started
      waiting = { input, resolve, reject };
      pump();
    });
}
