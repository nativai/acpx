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
  parseQueueRequest,
  type QueueOwnerErrorMessage,
  type QueueOwnerMessage,
  type QueueRequest,
} from "./messages.js";

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
  if (!task.messageId) {
    return;
  }
  const event = buildDeliveryEvent({
    messageId: task.messageId,
    requestId: task.requestId,
    phase,
    ...(error !== undefined ? { error } : {}),
  });
  void appendFile(sessionEventActivePath(sessionId), `${JSON.stringify(event)}\n`, "utf8").catch(
    () => {
      // Best effort — the owner may be tearing down; never throw from a marker.
    },
  );
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
  // A11 (brick://53437107 §G2b): set the instant any path writes this task's
  // delivery terminal, so the owner-exit writer below and the closed-record
  // refusal (runtime.ts `terminalizeDeliveryRefusedByClosedRecord`) cannot both
  // terminalize the same task. One terminal per task, ever — the same flag
  // discipline F3 uses for absorbed deliveries (absorbed-delivery-registry.ts).
  terminalWritten?: boolean;
  // Keep-warm idle-TTL override (ms; 0 = keep alive forever) carried from the
  // submit request; the owner runtime adopts it as its new idle TTL. Absent =>
  // leave the owner's TTL unchanged.
  ttlMs?: number;
  enqueuedAt: number;
  send: (message: QueueOwnerMessage) => void;
  close: () => void;
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
  private socketRepair?: Promise<boolean>;
  private closed = false;

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

    for (const task of this.pending.splice(0)) {
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
      } else if (!task.terminalWritten) {
        // C4 (G3): a deliver-now task's socket was already closed on acceptance,
        // so there is no waiter to notify. Without a terminal it would sit
        // accepted-forever once the owner dies. Write a retryable
        // QUEUE_OWNER_SHUTDOWN terminal so acpx-ui's owner-gone re-drive/resend
        // takes over. This class never reached the model (never accepted), so a
        // resend is safe — no double-execution concern.
        // A11: skipped when the task already carries a terminal (a task refused
        // by a closed record and re-queued) — one terminal per task, ever.
        task.terminalWritten = true;
        appendDeliveryStreamEvent(this.sessionId, task, "failed", {
          code: 0,
          message: "Queue owner shut down before the message was accepted",
          detailCode: "QUEUE_OWNER_SHUTDOWN",
        });
      }
      task.close();
    }
    this.emitQueueDepth();

    await this.socketRepair?.catch(() => {
      // A failed repair already left the listener unavailable; shutdown still
      // needs to release the owner lease and adapter process.
    });
    await closeQueueSocket(this.server);
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
    if (this.pending.length > 0) {
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
    return false;
  }

  private enqueuePromptRequest(
    socket: net.Socket,
    request: Extract<QueueRequest, { type: "submit_prompt" }>,
  ): void {
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
