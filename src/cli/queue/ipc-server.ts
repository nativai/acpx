import { appendFileSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import net from "node:net";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { recordPerfDuration } from "../../perf-metrics.js";
import { textPrompt } from "../../prompt-content.js";
import {
  buildDeliveryEvent,
  type DeliveryEventError,
  type DeliveryPhase,
} from "../../session/delivery-events.js";
import { sessionEventActivePath } from "../../session/event-log.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
  SessionResumePolicy,
} from "../../types.js";
import {
  type OwnerExitCause,
  ownerExitDeliveryError,
  QUEUE_OWNER_CLOSING_DETAIL_CODE,
  QUEUE_OWNER_CLOSING_MESSAGE,
} from "./delivery-terminals.js";
import {
  parseQueueRequest,
  type QueueDrainedDelivery,
  type QueueDrainReason,
  type QueueOwnerDrainResultMessage,
  type QueueOwnerErrorMessage,
  type QueueOwnerMessage,
  type QueueRequest,
} from "./messages.js";

// How often the drain re-reads the runtime's local turn signal while waiting for
// an in-flight turn to end. A synchronous in-process read, so the cadence costs
// nothing; the wait as a whole is bounded by the caller's `--drain-timeout`.
const DRAIN_TURN_POLL_INTERVAL_MS = 25;

type QueueOwnerSocketLease = {
  sessionId: string;
  socketPath: string;
  ownerGeneration?: number;
};

async function isSocketPathMissing(socketPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }

  try {
    await stat(socketPath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

async function listenOnQueueSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(socketPath);
  });
}

async function closeQueueSocket(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function makeQueueOwnerError(
  requestId: string,
  message: string,
  detailCode: string,
  options: {
    retryable?: boolean;
  } = {},
): QueueOwnerErrorMessage {
  return {
    type: "error",
    requestId,
    ownerGeneration: undefined,
    code: "RUNTIME",
    detailCode,
    origin: "queue",
    retryable: options.retryable,
    message,
  };
}

function makeQueueOwnerErrorFromUnknown(
  requestId: string,
  error: unknown,
  detailCode: string,
  options: {
    retryable?: boolean;
  } = {},
): QueueOwnerErrorMessage {
  const normalized = normalizeOutputError(error, {
    defaultCode: "RUNTIME",
    origin: "queue",
    detailCode,
    retryable: options.retryable,
  });

  return {
    type: "error",
    requestId,
    code: normalized.code,
    detailCode: normalized.detailCode,
    origin: normalized.origin,
    message: normalized.message,
    retryable: normalized.retryable,
    acp: normalized.acp,
  };
}

function writeQueueMessage(socket: net.Socket, message: QueueOwnerMessage): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

// C4 (G3): append a delivery lifecycle event straight to the session stream, the
// same fire-and-forget direct-appendFile pattern as the `acpx/received` marker.
// Used for the `queued` visibility event and the owner-exit `QUEUE_OWNER_SHUTDOWN`
// terminal — points where no SessionEventWriter is held (the owner may be dying).
// A task with no messageId has no delivery lifecycle to update, so it is skipped.
export function appendDeliveryStreamEvent(
  sessionId: string,
  task: Pick<QueueTask, "messageId" | "requestId">,
  phase: DeliveryPhase,
  error?: DeliveryEventError,
): void {
  const line = deliveryStreamLine(task, phase, error);
  if (!line) {
    return;
  }
  void appendFile(sessionEventActivePath(sessionId), line, "utf8").catch(() => {
    // Best effort — the owner may be tearing down; never throw from a marker.
  });
}

// D1 (brick://53437107) — the SYNCHRONOUS sibling, for exit paths only.
//
// `appendDeliveryStreamEvent` above hands the write to libuv and returns. On an
// exit path that write has NOT flushed when the process goes away — which is
// precisely why every externally-killed owner lost its custody silently (class B:
// no SIGTERM handler ran at all) and why even the graceful `close()` was
// racing its own process-group SIGKILL. A signal handler or an owner-exit sweep
// must use THIS one, or the terminals are lost exactly when they matter most
// (GROUND-TRUTH G5; TESTER-PLAN trap 2 — L1.1 passes with the async writer, only
// L1.5's real-SIGTERM-then-read-the-file gate catches the missing flush).
//
// Sub-millisecond, no awaits, never throws: safe inside the 1.5 s
// PROCESS_EXIT_GRACE_MS window before SIGKILL.
export function appendDeliveryStreamEventSync(
  sessionId: string,
  task: Pick<QueueTask, "messageId" | "requestId">,
  phase: DeliveryPhase,
  error?: DeliveryEventError,
): void {
  const line = deliveryStreamLine(task, phase, error);
  if (!line) {
    return;
  }
  try {
    appendFileSync(sessionEventActivePath(sessionId), line, "utf8");
  } catch {
    // Best effort — the owner is tearing down; never throw from a marker.
  }
}

// A task with no messageId has no delivery lifecycle to update, so it is skipped.
function deliveryStreamLine(
  task: Pick<QueueTask, "messageId" | "requestId">,
  phase: DeliveryPhase,
  error?: DeliveryEventError,
): string | undefined {
  if (!task.messageId) {
    return undefined;
  }
  const event = buildDeliveryEvent({
    messageId: task.messageId,
    requestId: task.requestId,
    phase,
    ...(error !== undefined ? { error } : {}),
  });
  return `${JSON.stringify(event)}\n`;
}

export type QueueTask = {
  requestId: string;
  messageId?: string;
  message: string;
  prompt: PromptInput;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: AcpClientOptions["permissionPolicy"];
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  promptRetries?: number;
  sessionOptions?: NonNullable<AcpClientOptions["sessionOptions"]>;
  waitForCompletion: boolean;
  // ONE TERMINAL PER TASK, EVER (A11, brick://53437107 §G2b). Set SYNCHRONOUSLY
  // the instant any path writes this task's delivery terminal — the same flag
  // discipline F3 uses for absorbed deliveries (absorbed-delivery-registry.ts).
  //
  // Four writers now share it, which is exactly why it is one flag and not a
  // guard duplicated per call site:
  //   - the closed-record refusal  (runtime.ts terminalizeDeliveryRefusedByClosedRecord)
  //   - the close-drain barrier    (drainDeliveries)
  //   - the SIGTERM/SIGINT sweep   (terminalizeCustodyOnSignal)
  //   - owner exit                 (close)
  // The last three all run through `terminalizeCustody`, so they honour it by
  // construction rather than by three separately-correct edits. A duplicate
  // delivery terminal here would reopen brick://932a1e5e.
  terminalWritten?: boolean;
  // Keep-warm idle-TTL override (ms; 0 = keep alive forever) carried from the
  // submit request; the owner runtime adopts it as its new idle TTL. Absent =>
  // leave the owner's TTL unchanged.
  ttlMs?: number;
  enqueuedAt: number;
  send: (message: QueueOwnerMessage) => void;
  close: () => void;
};

// What the drain took off the owner, and what the agent that issued the close
// therefore lost custody of.
export type QueueOwnerDrainReport = {
  drained: number;
  undelivered: QueueDrainedDelivery[];
  turnSettled: boolean;
  activeTurnAtEntry: boolean;
};

export type QueueOwnerControlHandlers = {
  cancelPrompt: () => Promise<boolean>;
  closeSession: (timeoutMs?: number) => Promise<boolean>;
  setSessionMode: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionModel: (modelId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
  queryActiveTurn: () => boolean;
};

type SessionQueueOwnerOptions = {
  maxQueueDepth: number;
  onQueueDepthChanged?: (queueDepth: number) => void;
};

export class SessionQueueOwner {
  private readonly server: net.Server;
  private readonly controlHandlers: QueueOwnerControlHandlers;
  private readonly sessionId: string;
  private readonly socketPath: string;
  private readonly ownerGeneration?: number;
  private readonly maxQueueDepth: number;
  private readonly onQueueDepthChanged?: (queueDepth: number) => void;
  private readonly pending: QueueTask[] = [];
  private readonly waiters: Array<(task: QueueTask | undefined) => void> = [];
  private midTurnHandler?: (task: QueueTask) => boolean;
  // D1 — takes (and REMOVES) whatever the runtime is holding in its mid-turn
  // capture buffer. Custody lives in two places, so the drain must walk both
  // (corollary C-1); the runtime owns that array, so it injects the accessor.
  private midTurnCustodySource?: () => QueueTask[];
  private socketRepair?: Promise<boolean>;
  private closed = false;
  // D1 — the quiesce flag. Set the instant a drain starts and never cleared: a
  // draining owner is on its way out. This is where the RCA's TOCTOU actually
  // closes — at the only process that is authoritative about its own liveness,
  // rather than in an acpx-ui route that reads a file and hopes.
  private draining = false;
  private drainCause: OwnerExitCause = "owner-exit";

  private constructor(
    server: net.Server,
    controlHandlers: QueueOwnerControlHandlers,
    lease: QueueOwnerSocketLease,
    options: SessionQueueOwnerOptions,
  ) {
    this.server = server;
    this.controlHandlers = controlHandlers;
    this.sessionId = lease.sessionId;
    this.socketPath = lease.socketPath;
    this.ownerGeneration = lease.ownerGeneration;
    this.maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth));
    this.onQueueDepthChanged = options.onQueueDepthChanged;
  }

  static async start(
    lease: QueueOwnerSocketLease,
    controlHandlers: QueueOwnerControlHandlers,
    options: SessionQueueOwnerOptions = {
      maxQueueDepth: 16,
    },
  ): Promise<SessionQueueOwner> {
    const ownerRef: { current: SessionQueueOwner | undefined } = { current: undefined };
    const server = net.createServer((socket) => {
      ownerRef.current?.handleConnection(socket);
    });
    ownerRef.current = new SessionQueueOwner(server, controlHandlers, lease, options);

    await listenOnQueueSocket(server, lease.socketPath);

    return ownerRef.current;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }

    this.terminalizeCustody(this.pending.splice(0), this.drainCause);
    this.emitQueueDepth();

    await this.socketRepair?.catch(() => {
      // A failed repair already left the listener unavailable; shutdown still
      // needs to release the owner lease and adapter process.
    });
    await closeQueueSocket(this.server);
  }

  /**
   * D1 (brick://53437107) — the close-drain barrier, owner side.
   *
   * Quiesce, settle what is already with the agent, then terminalize what never
   * reached it. The one thing this deliberately does NOT do is DELIVER: injecting
   * a pending message and then killing the turn means the model consumed it and
   * the answer was destroyed, leaving the item `outcome_unknown` and therefore
   * never auto-resendable. Not injecting leaves it `not_delivered` and safely
   * resendable — the "deliver it first" instinct produces the strictly worse
   * outcome (KD-2 / corollary C-2). There is no drain-and-deliver mode.
   *
   * Idempotent (E4): the second caller finds an empty `pending`, an already-set
   * `draining` flag, and reports `undelivered: []`.
   */
  async drainDeliveries(
    reason: QueueDrainReason,
    timeoutMs?: number,
  ): Promise<QueueOwnerDrainReport> {
    const activeTurnAtEntry = this.controlHandlers.queryActiveTurn();

    // 1. Quiesce, before any await. From this instant `submit_prompt` is
    //    rejected, so nothing can arrive between here and the SIGTERM that
    //    follows (E5) — which is what makes the signal handler's
    //    QUEUE_OWNER_SHUTDOWN default provably correct.
    this.draining = true;
    this.drainCause = reason === "session-close" ? "session-close" : "owner-exit";

    // 2. Settle what is already WITH the agent. Never cancel it: the answer to a
    //    running turn is not ours to destroy, and an absorbed injection whose
    //    turn never ends is F3's ABSORBED_TURN_NEVER_ENDED to label (E1).
    const turnSettled = await this.waitForTurnToSettle(timeoutMs);

    // 3. Terminalize what never reached the agent. Both custody structures are
    //    spliced in ONE synchronous pass, so an item this sweep took can no
    //    longer be reached by `close()`, by a concurrent drain, or by the signal
    //    handler — no double terminal, no double delivery (brick://932a1e5e).
    const custody = [...this.pending.splice(0), ...(this.midTurnCustodySource?.() ?? [])];
    const undelivered = this.terminalizeCustody(custody, this.drainCause);
    this.emitQueueDepth();

    return {
      drained: undelivered.length,
      undelivered,
      turnSettled,
      activeTurnAtEntry,
    };
  }

  /**
   * Signal-path custody sweep (A6 / risk R1). SYNCHRONOUS end to end — no awaits,
   * no I/O that can block — so a SIGTERM handler finishes well inside the 1.5 s
   * PROCESS_EXIT_GRACE_MS window before SIGKILL. Returns the terminals written.
   *
   * Defaults to QUEUE_OWNER_SHUTDOWN (retryable, session still open), which is
   * correct for every external kill; only a drain that already ran for a close
   * flips `drainCause`, and in that case there is nothing left to sweep anyway.
   */
  terminalizeCustodyOnSignal(): number {
    const custody = [...this.pending.splice(0), ...(this.midTurnCustodySource?.() ?? [])];
    return this.terminalizeCustody(custody, this.drainCause).length;
  }

  isDraining(): boolean {
    return this.draining;
  }

  // Poll the runtime's authoritative local turn signal until it goes idle or the
  // budget expires. Bounded by `timeoutMs`; a busy recipient simply reports
  // `turnSettled:false` and the close proceeds.
  private async waitForTurnToSettle(timeoutMs?: number): Promise<boolean> {
    if (!this.controlHandlers.queryActiveTurn()) {
      return true;
    }
    const deadline = Date.now() + Math.max(0, timeoutMs ?? 0);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_TURN_POLL_INTERVAL_MS));
      if (!this.controlHandlers.queryActiveTurn()) {
        return true;
      }
    }
    return !this.controlHandlers.queryActiveTurn();
  }

  // Write one honest owner-exit terminal per task and hand the sockets back.
  // Every write here is SYNCHRONOUS because every caller is an exit path.
  private terminalizeCustody(tasks: QueueTask[], cause: OwnerExitCause): QueueDrainedDelivery[] {
    const undelivered: QueueDrainedDelivery[] = [];
    for (const task of tasks) {
      // A11's invariant, absorbed here rather than duplicated at each sweep:
      // ONE TERMINAL PER TASK, EVER. A task refused by a closed record
      // (`runtime.ts` `terminalizeDeliveryRefusedByClosedRecord`) already carries
      // its terminal, so this sweep must neither re-write it nor report it as
      // custody IT lost — but the socket is still handed back. A11's HC-2 is the
      // gate on this branch; if it reds, this resolution is wrong, not the test.
      if (task.terminalWritten) {
        task.close();
        continue;
      }
      // Flag flip first, synchronously — the F3 precedent
      // (`absorbed-delivery-registry.ts`). Set for BOTH branches below, so a
      // second sweep re-sends nothing at all, not merely no stream terminal.
      task.terminalWritten = true;
      undelivered.push({
        requestId: task.requestId,
        ...(task.messageId !== undefined ? { messageId: task.messageId } : {}),
      });

      if (task.waitForCompletion) {
        task.send(
          makeQueueOwnerError(
            task.requestId,
            "Queue owner shutting down before prompt execution",
            "QUEUE_OWNER_SHUTTING_DOWN",
            {
              retryable: true,
            },
          ),
        );
      } else {
        // C4 (G3): a deliver-now task's socket was already closed on acceptance,
        // so there is no waiter to notify. Without a terminal it would sit
        // accepted-forever once the owner dies. The CODE is chosen by cause
        // (A5): retryable QUEUE_OWNER_SHUTDOWN while the session is still open,
        // definitive SESSION_CLOSED_UNDELIVERED when draining for close.
        appendDeliveryStreamEventSync(
          this.sessionId,
          task,
          "failed",
          ownerExitDeliveryError(cause),
        );
      }
      task.close();
    }
    return undelivered;
  }

  // The runtime's mid-turn capture buffer is the owner's SECOND custody store
  // (corollary C-1). It lives in `runSessionQueueOwner`, so the runtime injects
  // an accessor that both returns and removes its contents in one synchronous
  // call — mirroring `setMidTurnHandler`.
  setMidTurnCustodySource(take: () => QueueTask[]): void {
    this.midTurnCustodySource = take;
  }

  clearMidTurnCustodySource(): void {
    this.midTurnCustodySource = undefined;
  }

  /**
   * Restore this owner's advertised Unix socket after its pathname was removed.
   *
   * The queue-owner runtime calls this only at its authoritative idle/empty
   * boundary. The existing listener is still alive on an unlinked inode, so it
   * is closed and re-listened at the same path without changing pid, lease,
   * owner generation, adapter, or session context. Concurrent continuity checks
   * share one repair promise and therefore cannot create listener storms.
   */
  repairSocketIfMissing(canRepair: () => boolean = () => true): Promise<boolean> {
    if (this.socketRepair) {
      return this.socketRepair;
    }

    const repair = this.probeAndRepairMissingSocket(canRepair);
    const trackedRepair = repair.finally(() => {
      if (this.socketRepair === trackedRepair) {
        this.socketRepair = undefined;
      }
    });
    this.socketRepair = trackedRepair;
    return trackedRepair;
  }

  private canRepairSocket(canRepair: () => boolean): boolean {
    return !this.closed && process.platform !== "win32" && canRepair();
  }

  private async probeAndRepairMissingSocket(canRepair: () => boolean): Promise<boolean> {
    if (!this.canRepairSocket(canRepair)) {
      return false;
    }
    if (!(await isSocketPathMissing(this.socketPath))) {
      return false;
    }
    // Re-check the runtime's authoritative quiescence gate after the async stat.
    // This closes the only TOCTOU window where a turn could start while the
    // missing-path probe was in flight.
    if (!this.canRepairSocket(canRepair)) {
      return false;
    }

    await closeQueueSocket(this.server);
    if (this.closed) {
      return false;
    }

    await listenOnQueueSocket(this.server, this.socketPath);
    if (this.closed) {
      await closeQueueSocket(this.server);
      return false;
    }
    return true;
  }

  async nextTask(timeoutMs?: number): Promise<QueueTask | undefined> {
    // A draining owner never STARTS new work (KD-2 / C-2). Without this a turn
    // that settles during the drain would let the runtime pull the very task the
    // drain is about to terminalize, inject it, and then have it killed by the
    // close — turning a recoverable `not_delivered` into an unrecoverable
    // `outcome_unknown`. Falling through to the waiter (rather than returning
    // immediately) parks the runtime loop instead of spinning it hot; nothing
    // can feed that waiter, because `enqueue` is quiesced.
    if (!this.draining && this.pending.length > 0) {
      const task = this.pending.shift();
      this.emitQueueDepth();
      if (task) {
        recordPerfDuration("queue.owner.wait_ms", Date.now() - task.enqueuedAt);
      }
      return task;
    }
    if (this.closed) {
      return undefined;
    }

    return await new Promise<QueueTask | undefined>((resolve) => {
      const shouldTimeout = timeoutMs != null;
      const timer =
        shouldTimeout &&
        setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) {
              this.waiters.splice(index, 1);
            }
            resolve(undefined);
          },
          Math.max(0, timeoutMs),
        );

      const waiter = (task: QueueTask | undefined) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(task);
      };

      this.waiters.push(waiter);
    });
  }

  queueDepth(): number {
    return this.pending.length;
  }

  setMidTurnHandler(handler: (task: QueueTask) => boolean): void {
    this.midTurnHandler = handler;
  }

  clearMidTurnHandler(): void {
    this.midTurnHandler = undefined;
  }

  requeue(task: QueueTask): void {
    this.requeueAll([task]);
  }

  // C4 (G3): requeue a batch of previously-buffered mid-turn tasks WITHOUT
  // reversing them. The old per-item `unshift` reversed each batch (newest
  // first) and starved the oldest across successive drain cycles (RCA §3:
  // a2520124). Prepend the batch as a block, then stable-sort the whole pending
  // queue by arrival time so cross-batch order is the single invariant.
  requeueAll(tasks: QueueTask[]): void {
    if (tasks.length === 0) {
      return;
    }
    this.pending.unshift(...tasks);
    // Array.prototype.sort is stable (V8), so equal enqueuedAt keeps insertion
    // order — arrival order becomes the one ordering invariant.
    this.pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    this.emitQueueDepth();
  }

  private emitQueueDepth(): void {
    this.onQueueDepthChanged?.(this.pending.length);
  }

  private enqueue(task: QueueTask): void {
    if (this.closed) {
      if (task.waitForCompletion) {
        task.send(
          makeQueueOwnerError(
            task.requestId,
            "Queue owner is shutting down",
            "QUEUE_OWNER_SHUTTING_DOWN",
            {
              retryable: true,
            },
          ),
        );
      }
      task.close();
      return;
    }

    // When a mid-turn handler is registered, new tasks are injected directly
    // into the active prompt turn instead of being queued.
    if (this.midTurnHandler?.(task)) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(task);
      return;
    }

    if (this.pending.length >= this.maxQueueDepth) {
      if (task.waitForCompletion) {
        task.send({
          ...makeQueueOwnerError(
            task.requestId,
            `Queue owner is overloaded (${this.pending.length}/${this.maxQueueDepth} queued)`,
            "QUEUE_OWNER_OVERLOADED",
            {
              retryable: true,
            },
          ),
          ownerGeneration: this.ownerGeneration,
        });
      }
      task.close();
      return;
    }

    this.pending.push(task);
    this.emitQueueDepth();
  }

  private handleControlRequest<TMessage extends QueueOwnerMessage>(options: {
    socket: net.Socket;
    requestId: string;
    run: () => Promise<TMessage>;
  }): void {
    writeQueueMessage(options.socket, {
      type: "accepted",
      requestId: options.requestId,
      ownerGeneration: this.ownerGeneration,
    });

    void options
      .run()
      .then((message) => {
        writeQueueMessage(options.socket, {
          ...message,
          ownerGeneration: this.ownerGeneration,
        });
      })
      .catch((error) => {
        writeQueueMessage(options.socket, {
          ...makeQueueOwnerErrorFromUnknown(
            options.requestId,
            error,
            "QUEUE_CONTROL_REQUEST_FAILED",
          ),
          ownerGeneration: this.ownerGeneration,
        });
      })
      .finally(() => {
        if (!options.socket.destroyed) {
          options.socket.end();
        }
      });
  }

  private failRequest(
    socket: net.Socket,
    requestId: string,
    message: string,
    detailCode: string,
  ): void {
    writeQueueMessage(socket, {
      ...makeQueueOwnerError(requestId, message, detailCode, {
        retryable: false,
      }),
      ownerGeneration: this.ownerGeneration,
    });
    socket.end();
  }

  private parseRequestLine(socket: net.Socket, line: string): QueueRequest | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failRequest(
        socket,
        "unknown",
        "Invalid queue request payload",
        "QUEUE_REQUEST_PAYLOAD_INVALID_JSON",
      );
      return undefined;
    }
    const request = parseQueueRequest(parsed);
    if (!request) {
      this.failRequest(socket, "unknown", "Invalid queue request", "QUEUE_REQUEST_INVALID");
    }
    return request ?? undefined;
  }

  private rejectStaleOwnerGeneration(socket: net.Socket, request: QueueRequest): boolean {
    if (
      request.ownerGeneration === undefined ||
      this.ownerGeneration === undefined ||
      request.ownerGeneration === this.ownerGeneration
    ) {
      return false;
    }
    this.failRequest(
      socket,
      request.requestId,
      "Queue request targeted a stale queue owner generation",
      "QUEUE_OWNER_GENERATION_MISMATCH",
    );
    return true;
  }

  private handleControlQueueRequest(socket: net.Socket, request: QueueRequest): boolean {
    if (request.type === "cancel_prompt") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => ({
          type: "cancel_result",
          requestId: request.requestId,
          cancelled: await this.controlHandlers.cancelPrompt(),
        }),
      });
      return true;
    }
    if (request.type === "close_session") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => ({
          type: "close_session_result",
          requestId: request.requestId,
          closed: await this.controlHandlers.closeSession(request.timeoutMs),
        }),
      });
      return true;
    }
    return this.handleSessionControlQueueRequest(socket, request);
  }

  private handleSessionControlQueueRequest(socket: net.Socket, request: QueueRequest): boolean {
    if (request.type === "set_mode") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => {
          await this.controlHandlers.setSessionMode(request.modeId, request.timeoutMs);
          return {
            type: "set_mode_result",
            requestId: request.requestId,
            modeId: request.modeId,
          };
        },
      });
      return true;
    }
    if (request.type === "set_model") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => {
          await this.controlHandlers.setSessionModel(request.modelId, request.timeoutMs);
          return {
            type: "set_model_result",
            requestId: request.requestId,
            modelId: request.modelId,
          };
        },
      });
      return true;
    }
    if (request.type === "set_config_option") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => ({
          type: "set_config_option_result",
          requestId: request.requestId,
          response: await this.controlHandlers.setSessionConfigOption(
            request.configId,
            request.value,
            request.timeoutMs,
          ),
        }),
      });
      return true;
    }
    if (request.type === "query_active_turn") {
      this.handleControlRequest({
        socket,
        requestId: request.requestId,
        run: async () => ({
          type: "query_active_turn_result",
          requestId: request.requestId,
          active: this.controlHandlers.queryActiveTurn(),
        }),
      });
      return true;
    }
    if (request.type === "drain_deliveries") {
      this.handleControlRequest<QueueOwnerDrainResultMessage>({
        socket,
        requestId: request.requestId,
        run: async () => ({
          type: "drain_deliveries_result",
          requestId: request.requestId,
          ...(await this.drainDeliveries(request.reason, request.timeoutMs)),
        }),
      });
      return true;
    }
    return false;
  }

  private enqueuePromptRequest(
    socket: net.Socket,
    request: Extract<QueueRequest, { type: "submit_prompt" }>,
  ): void {
    // A3 — the quiesce rejection (KD-4). Rejected BEFORE the `accepted` frame,
    // because `accepted` is what resolves a deliver-now submit as `{queued:true}`
    // on the client side; acking first and failing second would hand the sender
    // the same false assurance the whole brick exists to remove.
    //
    // The wording is load-bearing: already-deployed acpx-ui lower-cases this text
    // and substring-matches `session is closed` in `isTerminalEnqueueFailure`, so
    // the item fails immediately and honestly with NO acpx-ui change — which is
    // what lets acpx ship the barrier first.
    if (this.draining) {
      this.failRequest(
        socket,
        request.requestId,
        QUEUE_OWNER_CLOSING_MESSAGE,
        QUEUE_OWNER_CLOSING_DETAIL_CODE,
      );
      return;
    }

    const task: QueueTask = {
      requestId: request.requestId,
      messageId: request.messageId,
      message: request.message,
      prompt: request.prompt ?? textPrompt(request.message),
      permissionMode: request.permissionMode,
      resumePolicy: request.resumePolicy,
      nonInteractivePermissions: request.nonInteractivePermissions,
      permissionPolicy: request.permissionPolicy,
      timeoutMs: request.timeoutMs,
      suppressSdkConsoleErrors: request.suppressSdkConsoleErrors,
      promptRetries: request.promptRetries,
      sessionOptions: request.sessionOptions,
      waitForCompletion: request.waitForCompletion,
      ttlMs: request.ttlMs,
      enqueuedAt: Date.now(),
      send: (message) => {
        writeQueueMessage(socket, {
          ...message,
          ownerGeneration: this.ownerGeneration,
        });
      },
      close: () => {
        if (!socket.destroyed) {
          socket.end();
        }
      },
    };

    writeQueueMessage(socket, {
      type: "accepted",
      requestId: request.requestId,
      ownerGeneration: this.ownerGeneration,
    });
    const marker = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "acpx/received",
      params: {
        requestId: task.requestId,
        ...(task.messageId != null ? { messageId: task.messageId } : {}),
        at: new Date().toISOString(),
      },
    })}\n`;
    void appendFile(sessionEventActivePath(this.sessionId), marker, "utf8").catch(() => {});

    if (!request.waitForCompletion) {
      task.close();
    }

    this.enqueue(task);
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");

    if (this.closed) {
      writeQueueMessage(
        socket,
        makeQueueOwnerError("unknown", "Queue owner is closed", "QUEUE_OWNER_CLOSED", {
          retryable: true,
        }),
      );
      socket.end();
      return;
    }

    let buffer = "";
    let handled = false;

    const processLine = (line: string): void => {
      if (handled) {
        return;
      }
      handled = true;

      const request = this.parseRequestLine(socket, line);
      if (!request || this.rejectStaleOwnerGeneration(socket, request)) {
        return;
      }
      if (this.handleControlQueueRequest(socket, request)) {
        return;
      }
      if (request.type !== "submit_prompt") {
        this.failRequest(
          socket,
          request.requestId,
          "Invalid queue request",
          "QUEUE_REQUEST_INVALID",
        );
        return;
      }
      this.enqueuePromptRequest(socket, request);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.on("error", () => {
      // no-op: queue processing continues even if client disconnects
    });
  }
}
