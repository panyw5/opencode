import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { decodeAdmission, MutationID, RuntimeIdentity } from "../../src/extension/lifecycle-state"

/** Isolated identities with no relationship to an installed extension or user registry. */
export function executionIdentity() {
  const snapshot = decodeAdmission({
    version: 1,
    storeId: randomUUID(),
    installationId: randomUUID(),
    generationId: randomUUID(),
    revision: 0,
    epoch: 0,
    admission: { status: "open" },
    runtimes: [],
  })
  return {
    snapshot,
    identity: Schema.decodeUnknownSync(RuntimeIdentity)({
      storeId: snapshot.storeId,
      installationId: snapshot.installationId,
      generationId: snapshot.generationId,
      runtimeId: randomUUID(),
      epoch: 0,
    }),
    operationId: Schema.decodeUnknownSync(MutationID)(randomUUID()),
  }
}
