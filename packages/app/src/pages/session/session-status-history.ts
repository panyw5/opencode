export const sessionStatusHistoryKey = (sessionID: string | undefined, childSessionIDs: readonly string[]) =>
  `${sessionID ?? ""}\n--children--\n${[...new Set(childSessionIDs)].sort().join("\n")}`
