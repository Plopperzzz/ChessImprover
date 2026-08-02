import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';

/**
 * Follows a batch run over /ws/analysis/{job_id}.
 *
 * Deliberately not `useAnalysisJob`. A single-game job is one progress bar and
 * a result payload at the end; a batch is a run over a list, where what you
 * want to see is which game it is on, how many are done, and which ones broke
 * -- and where the result of each game is saved server-side as it finishes
 * rather than handed back at the end.
 *
 * Two things follow from the run belonging to the server rather than to this
 * page:
 *
 * * **Reconnecting is enough.** A long run outlives a screen lock or a
 *   discarded tab; the server replays a compacted event log on a new socket,
 *   so a dropped connection is a reconnect and not a lost run.
 * * **It can be found again.** `reattach` asks what is still running and picks
 *   the batch back up, which is what stops a reloaded page from starting a
 *   second run alongside the first.
 */
export interface BatchState {
  jobId: string | null;
  running: boolean;
  /** 0..1 across the whole run, or null before the first progress event. */
  fraction: number | null;
  /** Which game the run is on, and how many there are. */
  index: number | null;
  total: number | null;
  /** The game being analysed right now, for the status line. */
  current: string | null;
  completed: number;
  failed: number;
  /** One line per game that broke, keyed by index so a replay can't
   *  duplicate them. */
  failures: { index: number; message: string }[];
  /** How many jobs are ahead of this one in the worker pool. A batch leases
   *  per game, so this can appear mid-run when the other user takes the
   *  slots at a game boundary. */
  queuedAhead: number | null;
  /** Set once the run is over, saying how it ended. */
  note: string | null;
  error: string | null;
}

const IDLE: BatchState = {
  jobId: null,
  running: false,
  fraction: null,
  index: null,
  total: null,
  current: null,
  completed: 0,
  failed: 0,
  failures: [],
  queuedAhead: null,
  note: null,
  error: null,
};

/** How long to wait before picking a dropped socket back up. */
const RECONNECT_MS = 2000;

export function useBatchJob(onGameDone: () => void) {
  const [state, setState] = useState<BatchState>(IDLE);
  const socket = useRef<WebSocket | null>(null);
  const reconnect = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The run this hook is following, if any. Mirrored out of state because the
   *  socket's close handler has to read it, and reading it from state there
   *  would mean rebuilding the handler -- and so the socket -- on every event
   *  the run emits. */
  const watching = useRef<string | null>(null);
  // In a ref so reconnecting doesn't want the callback in a dependency list,
  // which would tear the socket down on every parent re-render.
  const doneRef = useRef(onGameDone);
  doneRef.current = onGameDone;

  const closeSocket = useCallback(() => {
    watching.current = null;
    if (reconnect.current) {
      clearTimeout(reconnect.current);
      reconnect.current = null;
    }
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close();
      socket.current = null;
    }
  }, []);

  const watch = useCallback(
    (jobId: string) => {
      if (reconnect.current) {
        clearTimeout(reconnect.current);
        reconnect.current = null;
      }
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
      }
      watching.current = jobId;

      const ws = new WebSocket(api.wsUrl(`/ws/analysis/${jobId}`));
      socket.current = ws;

      ws.onmessage = (raw) => {
        let event: { type: string; [key: string]: unknown };
        try {
          event = JSON.parse(raw.data);
        } catch {
          return;
        }
        const num = (key: string) =>
          typeof event[key] === 'number' ? (event[key] as number) : null;

        switch (event.type) {
          case 'queued':
            setState((s) => ({ ...s, queuedAhead: num('ahead') }));
            break;
          case 'started':
            setState((s) => ({ ...s, queuedAhead: null }));
            break;
          case 'game_start':
            setState((s) => ({
              ...s,
              queuedAhead: null,
              index: num('index'),
              total: num('total') ?? s.total,
              current: `${event.white || '?'} — ${event.black || '?'}`,
            }));
            break;
          case 'progress':
            setState((s) => ({ ...s, fraction: num('fraction') ?? s.fraction }));
            break;
          case 'game_done':
            setState((s) => ({
              ...s,
              completed: num('completed') ?? s.completed,
              failed: num('failed') ?? s.failed,
              fraction:
                num('index') != null && num('total')
                  ? ((num('index') as number) + 1) / (num('total') as number)
                  : s.fraction,
            }));
            // Each game is saved as it finishes, so the library can show it
            // analysed now rather than at the end of a run that may be hours
            // from over.
            doneRef.current();
            break;
          case 'game_failed':
            setState((s) => {
              const index = num('index');
              if (index != null && s.failures.some((f) => f.index === index)) return s;
              return {
                ...s,
                completed: num('completed') ?? s.completed,
                failed: num('failed') ?? s.failed,
                failures: [
                  ...s.failures,
                  { index: index ?? s.failures.length, message: String(event.message ?? 'failed') },
                ],
              };
            });
            break;
          case 'done': {
            const completed = num('completed') ?? 0;
            const failed = num('failed') ?? 0;
            const cancelled = event.cancelled === true;
            setState((s) => ({
              ...s,
              running: false,
              fraction: cancelled ? s.fraction : 1,
              current: null,
              queuedAhead: null,
              completed,
              failed,
              note: cancelled
                ? `Stopped after ${completed} game${completed === 1 ? '' : 's'} — those are saved.`
                : `Analysed ${completed} game${completed === 1 ? '' : 's'}` +
                  (failed ? `, ${failed} failed.` : '.'),
            }));
            closeSocket();
            doneRef.current();
            break;
          }
          case 'error':
            setState((s) => ({ ...s, running: false, error: String(event.message ?? 'failed') }));
            closeSocket();
            break;
        }
      };

      ws.onclose = (event) => {
        if (socket.current !== ws) return; // superseded, not dropped
        socket.current = null;
        // 4404 is "no such job" and 4401 "not yours": the run is finished and
        // evicted, or the server restarted. Neither is worth retrying, and
        // whatever it completed is saved.
        if (event.code === 4404 || event.code === 4401) {
          watching.current = null;
          setState((s) =>
            s.running
              ? {
                  ...s,
                  running: false,
                  current: null,
                  note: 'That run is no longer going — anything it finished is saved.',
                }
              : s,
          );
          doneRef.current();
          return;
        }
        reconnect.current = setTimeout(() => {
          reconnect.current = null;
          if (watching.current === jobId) watch(jobId);
        }, RECONNECT_MS);
      };
    },
    [closeSocket],
  );

  const start = useCallback(
    async (scope: api.BatchScope) => {
      setState({ ...IDLE, running: true });
      try {
        const { job_id, total, attached } = await api.startBatch(scope);
        setState({
          ...IDLE,
          jobId: job_id,
          running: true,
          total,
          note: attached ? 'That run was already going — picked it back up.' : null,
        });
        watch(job_id);
      } catch (e) {
        setState({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [watch],
  );

  /** Pick a run back up that this browser lost sight of. */
  const reattach = useCallback(
    (summary: api.JobSummary) => {
      setState({
        ...IDLE,
        jobId: summary.job_id,
        running: true,
        total: summary.total,
        fraction: summary.fraction,
      });
      watch(summary.job_id);
    },
    [watch],
  );

  const cancel = useCallback(async () => {
    const id = state.jobId;
    if (!id) return;
    setState((s) => ({ ...s, note: 'Stopping — every game already finished stays saved.' }));
    try {
      await api.cancelBatch(id);
    } catch {
      // Either the server has already forgotten the job -- which is as stopped
      // as it gets -- or the request never landed. The socket settles which:
      // a job that is gone closes it with 4404.
    }
  }, [state.jobId]);

  const dismiss = useCallback(() => {
    closeSocket();
    setState(IDLE);
  }, [closeSocket]);

  useEffect(() => closeSocket, [closeSocket]);

  return { state, start, cancel, reattach, dismiss };
}
