"""Bounded worker pool and fair job queue (spec section 10).

Every long-running piece of engine work -- a quick pass, a full analysis, a
standalone sweep, each game of a batch -- takes a *lease* from this pool
before it touches an engine. The pool is sized to the machine's CPU cores, so
two people analysing at once share the hardware instead of each spawning as
many threads as they like and thrashing.

This is deliberately a different pool from the persistent live-eval engines in
`engine_manager` (spec section 3): those are one-per-open-board, are idle
almost all the time, and are torn down by an idle sweep. Nothing here touches
them, and neither pool's accounting includes the other.

Three properties matter, and the scheduler is built around them:

* **Sized to the hardware.** Capacity is the CPU core count (override with
  ``WORKER_SLOTS``). A job reserves as many slots as the engine threads it is
  about to use, so "two jobs running" means "two jobs that together fit".
* **Neither user gets shut out.** Waiters are ordered by how many slots their
  owner already holds, then by arrival. A user holding nothing always sorts
  ahead of one already running something, and beyond that first job a user is
  capped at their fair share of the pool while anyone else is waiting.
* **No starvation of a big job.** Admission stops at the first waiter that
  does not fit rather than letting small jobs leapfrog it forever.

A long batch does *not* hold its lease for the whole run: it leases per game
and releases in between, so the other user's work gets in at the next game
boundary rather than waiting out a thousand games. The batch's engine
processes stay open across that gap -- they are idle, so they cost no CPU,
and reopening them per game is exactly what section 12 avoids.
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field


def default_capacity() -> int:
    """Slots in the pool. `WORKER_SLOTS` overrides, which is how you hand the
    machine back some headroom (or, on a dedicated box, take more)."""
    raw = os.environ.get("WORKER_SLOTS")
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
    return max(1, os.cpu_count() or 1)


def slots_for(settings: dict, mode: str = "quick") -> int:
    """How much of the pool a job should reserve.

    Stockfish's own Threads setting is the honest number: a pass configured
    for 4 threads really does want 4 cores. Maia is asked for its move with
    `go nodes 1` -- a single forward pass through the policy net -- so a
    sweep-only job reserves one slot. Full mode alternates the two passes
    rather than running them together, so it reserves the larger of the two
    for the whole job rather than juggling two leases mid-run.
    """
    if mode == "sweep":
        return 1
    return max(1, int(settings.get("stockfish_threads") or 1))


@dataclass
class Lease:
    key: int
    user_id: int
    job_id: str | None
    slots: int
    label: str
    started_at: float = field(default_factory=time.monotonic)


@dataclass
class _Waiter:
    user_id: int
    job_id: str | None
    slots: int
    label: str
    seq: int
    future: asyncio.Future
    queued_at: float = field(default_factory=time.monotonic)


class WorkerPool:
    def __init__(self, capacity: int | None = None):
        self.capacity = capacity or default_capacity()
        self._leases: dict[int, Lease] = {}
        self._waiters: list[_Waiter] = []
        self._seq = 0

    # ---- accounting -------------------------------------------------------

    @property
    def used(self) -> int:
        return sum(lease.slots for lease in self._leases.values())

    @property
    def free(self) -> int:
        return self.capacity - self.used

    def _held_by(self, user_id: int) -> int:
        return sum(lease.slots for lease in self._leases.values() if lease.user_id == user_id)

    def _active_users(self) -> set:
        return ({lease.user_id for lease in self._leases.values()}
                | {w.user_id for w in self._waiters})

    def _per_user_cap(self) -> int:
        """Fair share while more than one user has work in flight. Only ever
        applied *beyond* a user's first running job, so it can never leave a
        job permanently unadmittable."""
        return max(1, self.capacity // max(1, len(self._active_users())))

    # ---- scheduling -------------------------------------------------------

    def _can_admit(self, waiter: _Waiter) -> bool:
        if waiter.slots > self.free:
            return False
        held = self._held_by(waiter.user_id)
        if held == 0:
            # Everyone gets one job running regardless of fair share -- this is
            # what stops a request larger than the share from deadlocking.
            return True
        return held + waiter.slots <= self._per_user_cap()

    def _order(self) -> list[_Waiter]:
        # Least-served user first, then arrival order within a user.
        return sorted(self._waiters, key=lambda w: (self._held_by(w.user_id), w.seq))

    def _pump(self):
        while self._waiters:
            waiter = self._order()[0]
            if not self._can_admit(waiter):
                # Head-of-line on purpose: letting a cheap job jump a waiting
                # expensive one is how the expensive one never runs.
                return
            self._waiters.remove(waiter)
            lease = Lease(key=id(waiter), user_id=waiter.user_id, job_id=waiter.job_id,
                          slots=waiter.slots, label=waiter.label)
            self._leases[lease.key] = lease
            if not waiter.future.done():
                waiter.future.set_result(lease)
            else:
                # Cancelled between being chosen and being handed the lease.
                self._leases.pop(lease.key, None)

    def _discard(self, waiter: _Waiter):
        if waiter in self._waiters:
            self._waiters.remove(waiter)
            self._pump()  # one fewer active user can raise everyone's fair share

    def position_of(self, waiter: _Waiter) -> int:
        order = self._order()
        return order.index(waiter) if waiter in order else 0

    # ---- public API -------------------------------------------------------

    async def acquire(self, user_id: int, slots: int, job_id: str | None = None,
                      label: str = "", on_wait=None) -> Lease:
        slots = max(1, min(int(slots), self.capacity))
        self._seq += 1
        waiter = _Waiter(user_id=user_id, job_id=job_id, slots=slots, label=label,
                         seq=self._seq, future=asyncio.get_running_loop().create_future())
        self._waiters.append(waiter)
        self._pump()

        if not waiter.future.done() and on_wait is not None:
            await on_wait(self.position_of(waiter))
        try:
            return await waiter.future
        except asyncio.CancelledError:
            self._discard(waiter)
            # Vanishingly rare, but a lease handed over at the same instant the
            # task was cancelled would otherwise be leaked forever.
            if waiter.future.done() and not waiter.future.cancelled() and not waiter.future.exception():
                self.release(waiter.future.result())
            raise

    def release(self, lease: Lease):
        if self._leases.pop(lease.key, None) is None:
            return
        self._pump()

    def cancel_job(self, job_id: str):
        """Drop a job's queued request. A job that is already running is
        stopped by its own `cancelled` flag; this is for one still waiting,
        which would otherwise sit in the queue with nothing to check the flag."""
        for waiter in list(self._waiters):
            if waiter.job_id == job_id and not waiter.future.done():
                waiter.future.cancel()

    @asynccontextmanager
    async def lease(self, *, job=None, user_id: int | None = None, slots: int = 1,
                    label: str = "", notify: bool = True):
        """Holds a lease for the duration of the block.

        When `job` is given, a wait (and only a wait) is reported to that job's
        subscribers, so the browser can say "queued behind someone else"
        instead of showing a progress bar that never moves. The common
        uncontended case stays silent.
        """
        owner = user_id if user_id is not None else job.user_id
        job_id = getattr(job, "job_id", None)
        waited = False

        async def on_wait(ahead: int):
            nonlocal waited
            waited = True
            if job is not None and notify:
                await job.emit({"type": "queued", "ahead": ahead, "slots": slots,
                                "capacity": self.capacity, "label": label})

        lease = await self.acquire(owner, slots, job_id=job_id, label=label, on_wait=on_wait)
        if waited and job is not None and notify:
            await job.emit({"type": "started", "slots": lease.slots, "capacity": self.capacity})
        try:
            yield lease
        finally:
            self.release(lease)

    def status(self) -> dict:
        now = time.monotonic()
        return {
            "capacity": self.capacity,
            "used": self.used,
            "per_user_cap": self._per_user_cap(),
            "running": [
                {"job_id": l.job_id, "user_id": l.user_id, "slots": l.slots,
                 "label": l.label, "running_s": round(now - l.started_at, 1)}
                for l in self._leases.values()
            ],
            "queued": [
                {"job_id": w.job_id, "user_id": w.user_id, "slots": w.slots,
                 "label": w.label, "waiting_s": round(now - w.queued_at, 1)}
                for w in self._order()
            ],
        }


pool = WorkerPool()
