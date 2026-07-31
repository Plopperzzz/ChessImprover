import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import type { AnalysisMove, JobEvent, SweepResults } from '../types';

export type JobKind = 'quick' | 'full' | 'sweep';

export interface JobState {
  jobId: string | null;
  kind: JobKind | null;
  running: boolean;
  /** 0..1, or null before the first progress event. */
  fraction: number | null;
  /** Which pass is running: the Stockfish pass, or the Maia Elo sweep. */
  phase: 'stockfish' | 'maia' | null;
  /** The Elo grid point the sweep is currently walking, when phase is 'maia'. */
  elo: number | null;
  /** Position the job is looking at right now, so the board can follow along. */
  fen: string | null;
  queuedAhead: number | null;
  error: string | null;
}

export interface JobResult {
  moves?: AnalysisMove[];
  grid?: number[];
  results?: SweepResults;
  modelNote?: string | null;
}

const IDLE: JobState = {
  jobId: null,
  kind: null,
  running: false,
  fraction: null,
  phase: null,
  elo: null,
  fen: null,
  queuedAhead: null,
  error: null,
};

/**
 * Runs one analysis job and follows it over /ws/analysis/{job_id}.
 *
 * The job lives in the server process, not here: the socket only watches it.
 * That's what makes `attach` meaningful -- a page that reloaded mid-run finds
 * the job again through /api/analysis/active and picks the stream back up
 * (the server replays a compacted event log on connect), rather than starting
 * a second run on top of the first.
 */
export function useAnalysisJob(onDone: (result: JobResult, kind: JobKind) => void) {
  const [state, setState] = useState<JobState>(IDLE);
  const socket = useRef<WebSocket | null>(null);
  const kindRef = useRef<JobKind | null>(null);
  // Held in a ref so reconnecting doesn't need the callback in a dependency
  // list, which would tear the socket down on every parent re-render.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const closeSocket = useCallback(() => {
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close();
      socket.current = null;
    }
  }, []);

  const watch = useCallback(
    (jobId: string, kind: JobKind) => {
      closeSocket();
      kindRef.current = kind;
      setState({ ...IDLE, jobId, kind, running: true });

      const ws = new WebSocket(api.wsUrl(`/ws/analysis/${jobId}`));
      socket.current = ws;

      ws.onmessage = (raw) => {
        let event: JobEvent;
        try {
          event = JSON.parse(raw.data);
        } catch {
          return;
        }
        switch (event.type) {
          case 'queued':
            setState((s) => ({ ...s, queuedAhead: (event as { ahead?: number }).ahead ?? null }));
            break;
          case 'started':
            setState((s) => ({ ...s, queuedAhead: null }));
            break;
          case 'progress': {
            const e = event as {
              fraction?: number;
              phase?: 'stockfish' | 'maia';
              elo?: number;
              fen?: string;
            };
            setState((s) => ({
              ...s,
              fraction: e.fraction ?? s.fraction,
              phase: e.phase ?? s.phase,
              elo: e.elo ?? (e.phase === 'stockfish' ? null : s.elo),
              fen: e.fen ?? s.fen,
              queuedAhead: null,
            }));
            break;
          }
          case 'done': {
            const e = event as {
              moves?: AnalysisMove[];
              grid?: number[];
              results?: SweepResults;
              model_note?: string;
            };
            setState((s) => ({ ...s, running: false, fraction: 1, fen: null, phase: null }));
            doneRef.current(
              {
                moves: e.moves,
                grid: e.grid,
                results: e.results,
                modelNote: e.model_note ?? null,
              },
              kindRef.current ?? 'quick',
            );
            closeSocket();
            break;
          }
          case 'error':
            setState((s) => ({
              ...s,
              running: false,
              error: (event as { message: string }).message,
            }));
            closeSocket();
            break;
        }
      };

      ws.onclose = () => {
        setState((s) => (s.running ? { ...s, running: false } : s));
      };
    },
    [closeSocket],
  );

  const start = useCallback(
    async (kind: JobKind, gameId: number, runId: number | null) => {
      setState({ ...IDLE, kind, running: true });
      try {
        const starter =
          kind === 'full' ? api.startFull : kind === 'sweep' ? api.startSweep : api.startQuick;
        const { job_id } = await starter(gameId, runId);
        watch(job_id, kind);
        return job_id;
      } catch (err) {
        setState({ ...IDLE, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
    [watch],
  );

  const cancel = useCallback(async () => {
    const id = state.jobId;
    if (!id) return;
    try {
      await api.cancelJob(id);
    } catch {
      /* already gone; the socket will close on its own */
    }
  }, [state.jobId]);

  const reset = useCallback(() => {
    closeSocket();
    setState(IDLE);
  }, [closeSocket]);

  /** Re-join a job this browser started before it was reloaded. */
  const attach = useCallback(
    (summary: api.JobSummary) => {
      if (summary.kind === 'batch') return;
      watch(summary.job_id, summary.kind);
    },
    [watch],
  );

  useEffect(() => closeSocket, [closeSocket]);

  return { state, start, cancel, reset, attach };
}
