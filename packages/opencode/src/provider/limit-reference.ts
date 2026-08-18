import type * as ModelsDev from "@opencode-ai/core/models-dev"
import { findLimitReference as find, type LimitReference } from "@opencode-ai/core/limit-reference"

export type { LimitReference }

export function findLimitReference(
  modelID: string,
  catalog: Record<string, ModelsDev.Provider>,
): LimitReference | undefined {
  return find(modelID, catalog)
}

export const LimitReferenceUtil = {
  findLimitReference,
}
