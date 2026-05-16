import type { SessionCreateResult, SessionLoadResult } from "../acp/client.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { cloneSessionAcpxState } from "./conversation-model.js";

type ConfigOptionsResult = Pick<SessionCreateResult | SessionLoadResult, "configOptions">;

export function applyConfigOptionsToRecord(
  record: SessionRecord,
  result: ConfigOptionsResult | undefined,
): void {
  const configOptions = result?.configOptions;
  if (!configOptions) {
    return;
  }

  const acpxState: SessionAcpxState = cloneSessionAcpxState(record.acpx) ?? {};
  acpxState.config_options = structuredClone(configOptions);
  record.acpx = acpxState;
}
