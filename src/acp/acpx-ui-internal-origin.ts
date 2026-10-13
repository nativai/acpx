import { readFileSync } from "node:fs";
import { parseNamespaceFromResolvConf, SERVICE_ACCOUNT_NAMESPACE_FILE } from "./auth-env.js";

/**
 * The same-box acpx-ui, addressed CLUSTER-INTERNALLY — the origin an in-cluster process
 * POSTs or GETs to without a client certificate.
 *
 * 🛑 THE PUBLIC acpx-ui BASE URL (`resolveAcpxUiBaseUrl`) IS NOT THIS ORIGIN: that host is
 * mTLS-protected, so an in-cluster request to it is refused before it reaches the route.
 *
 * Origin ladder (first hit wins):
 *   1. `ACPX_UI_INTERNAL_URL`, when SET — authoritative even when EMPTY (empty = "no origin",
 *      which is how a row asks for the no-origin arm without falling through to the box).
 *      The suite bootstrap (`test/box-env-scrub.ts`) points it at a dead port so no test can
 *      reach the box's real acpx-ui by accident.
 *   2. `http://dev-server.<this box's namespace>.svc.cluster.local:3456` — the namespace from
 *      the service-account file, else from `/etc/resolv.conf`'s search line.
 *   3. nothing.
 *
 * ONE ladder, two callers (brick cfcfa0de): `sessions activate`'s notice delivery
 * (`src/cli/session/notice-delivery.ts`) and the Codex quota admission
 * (`src/runtime/engine/codex-subscription-cap.ts`, which adds its own loopback rung after 3).
 * Two spellings of one rule is how a second caller drifts from the first.
 */
const INTERNAL_ACPX_UI_PORT = 3456;
const INTERNAL_ACPX_UI_SERVICE = "dev-server";
const RESOLV_CONF_FILE = "/etc/resolv.conf";

export type AcpxUiInternalOriginSources = { namespaceFile?: string; resolvConf?: string };

export function resolveAcpxUiInternalOrigin(
  env: NodeJS.ProcessEnv,
  sources: AcpxUiInternalOriginSources,
): string | undefined {
  if (env.ACPX_UI_INTERNAL_URL !== undefined) {
    const explicit = env.ACPX_UI_INTERNAL_URL.trim().replace(/\/+$/, "");
    return explicit.length > 0 ? explicit : undefined;
  }
  const fromFile = sources.namespaceFile?.trim();
  const namespace =
    fromFile && fromFile.length > 0
      ? fromFile
      : sources.resolvConf
        ? parseNamespaceFromResolvConf(sources.resolvConf)
        : undefined;
  return namespace
    ? `http://${INTERNAL_ACPX_UI_SERVICE}.${namespace}.svc.cluster.local:${INTERNAL_ACPX_UI_PORT}`
    : undefined;
}

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** This pod's own rung-2 sources, read fresh. Never throws. */
export function readAcpxUiInternalOriginSources(): AcpxUiInternalOriginSources {
  return {
    namespaceFile: readOrUndefined(SERVICE_ACCOUNT_NAMESPACE_FILE),
    resolvConf: readOrUndefined(RESOLV_CONF_FILE),
  };
}
