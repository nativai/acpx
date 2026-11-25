import { AcpxOperationalError } from "../errors.js";

export const DB_AT_OLD_PLACE_REASON = "db_at_old_place";

/** RED-FIRST STUB: the rows of test/pod-db-dir.test.ts fail by assertion; the behaviour follows. */
export class DatabaseAtOldPlaceError extends AcpxOperationalError {
  constructor(readonly database: string) {
    super(`acpx: REFUSED reason=${DB_AT_OLD_PLACE_REASON} db=${database}`, {
      outputCode: "USAGE",
      detailCode: DB_AT_OLD_PLACE_REASON,
      origin: "cli",
    });
    this.name = "DatabaseAtOldPlaceError";
  }
}
