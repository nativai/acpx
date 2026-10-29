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

const LOOPBACK_ACPX_UI_ORIGIN = `http://127.0.0.1:${INTERNAL_ACPX_UI_PORT}`;

/**
 * The box-local atrium for the archive verbs' HTTP reads — the wave's liveness probe
 * (`GET /api/sessions/<id>/status`) and the compression capability probe
 * (`GET /api/sessions/archived/stats?capability=1`). Brick 1861b06d.
 *
 * 🛑 NEVER THE PUBLIC `ACPX_UI_BASE_URL` WHEN IT IS https. On every real box it is the
 * mTLS host (`https://atrium.<cloister>`); from the control pod a request to it dies in
 * the TLS handshake (measured 2026-10-29 on devbox: `UND_ERR_SOCKET` in 84 ms), so a
 * probe built on it answered "unavailable" for EVERY id — the wave's primary liveness
 * signal had been dead on production, masked only because atrium's own `--exclude-ids`
 * carries the same judgement on the nightly run.
 *
 * Ladder (first hit wins):
 *   1. `ACPX_UI_BASE_URL` when it is plain `http:` — an explicit local pointer (a rig's
 *      atrium hands its child its own loopback listener, so a rig probes ITSELF).
 *   2. the cluster-internal ladder above (`ACPX_UI_INTERNAL_URL`, else the namespace's
 *      `dev-server` Service).
 *   3. same-pod loopback.
 * `test/atrium-local-origin.test.ts` pins every rung, the public-host case included.
 */
export function resolveAtriumLocalOrigin(
  env: NodeJS.ProcessEnv,
  sources: AcpxUiInternalOriginSources,
): string {
  const base = env.ACPX_UI_BASE_URL?.trim().replace(/\/+$/, "");
  if (base && /^http:\/\//i.test(base)) {
    return base;
  }
  return resolveAcpxUiInternalOrigin(env, sources) ?? LOOPBACK_ACPX_UI_ORIGIN;
}
