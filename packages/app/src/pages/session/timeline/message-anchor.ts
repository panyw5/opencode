import type { TimelineRow } from "./rows"

export type TimelineRowMessageIdentity = Pick<TimelineRow.TimelineRow, "_tag" | "userMessageID"> & {
  anchor?: boolean
}

export function isMessageAnchorRow(row: TimelineRowMessageIdentity) {
  return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor === true)
}

export function messageAnchorRowIndices(rows: TimelineRowMessageIdentity[]) {
  const result = new Map<string, number>()
  rows.forEach((row, index) => {
    // TurnGap is a layout-only row inserted before every turn after the
    // first. A reveal must land on the actual message anchor, not that gap.
    if (!isMessageAnchorRow(row) || result.has(row.userMessageID)) return
    result.set(row.userMessageID, index)
  })
  return result
}
