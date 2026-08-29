/**
 * 修复被误刷的 session.time_updated
 *
 * 问题：2026-08-25 09:32:38 有 10 个 opencode 项目的旧会话被批量将
 * time_updated 刷到了当前时间（1787621558448~1787621558465），
 * 导致它们在按 time_updated 降序的会话列表中排到了最前面。
 *
 * 修复方式：将这些会话的 time_updated 恢复为最后一条消息的时间。
 * 如果会话没有消息，则恢复为 time_created。
 *
 * 用法：bun run packages/opencode/script/fix-session-time-updated.ts
 */
import { Database as BunDatabase } from "bun:sqlite"

const DB_PATH =
  process.env.OPENCODE_DB ||
  `${process.env.HOME}/.local/share/opencode/opencode.db`

const db = new BunDatabase(DB_PATH)
db.run("PRAGMA journal_mode = WAL")

// 找出所有 time_updated 比最后一条消息时间晚超过 1 小时的会话
// 且 time_updated 明显偏离 time_created
const victims = db
  .query(
    `
    SELECT
      s.id,
      s.project_id,
      s.title,
      s.time_created,
      s.time_updated,
      m.max_msg AS last_msg_time,
      (s.time_updated - m.max_msg) / 1000 AS drift_seconds
    FROM session s
    JOIN (
      SELECT session_id, MAX(time_created) AS max_msg
      FROM message
      GROUP BY session_id
    ) m ON m.session_id = s.id
    WHERE s.time_updated > m.max_msg + 3600000
      AND s.time_updated > s.time_created + 3600000
    ORDER BY (s.time_updated - m.max_msg) DESC
  `,
  )
  .all() as Array<{
  id: string
  project_id: string
  title: string
  time_created: number
  time_updated: number
  last_msg_time: number
  drift_seconds: number
}>

console.log(`\n发现 ${victims.length} 个会话的 time_updated 偏离超过 1 小时:\n`)
for (const v of victims) {
  const created = new Date(v.time_created).toLocaleString()
  const updated = new Date(v.time_updated).toLocaleString()
  const lastMsg = new Date(v.last_msg_time).toLocaleString()
  const driftHours = (v.drift_seconds / 3600).toFixed(1)
  console.log(
    `  [${v.id.slice(0, 20)}...] ${v.title}\n` +
      `    创建: ${created}\n` +
      `    更新: ${updated}\n` +
      `    最后消息: ${lastMsg}\n` +
      `    漂移: ${driftHours} 小时\n`,
  )
}

// 修复：将 time_updated 恢复为最后消息时间
// 对于有消息的会话：time_updated = max(time_created, max(message.time_created))
// 对于无消息的会话：time_updated = time_created
const fixWithMessages = db.run(`
  UPDATE session
  SET time_updated = (
    SELECT MAX(time_created)
    FROM message
    WHERE message.session_id = session.id
  )
  WHERE EXISTS (
    SELECT 1 FROM message WHERE message.session_id = session.id
  )
  AND time_updated > (
    SELECT MAX(time_created)
    FROM message
    WHERE message.session_id = session.id
  )
  AND time_updated > time_created + 3600000
`)

console.log(`\n修复了 ${fixWithMessages.changes} 个有消息的会话`)

// 验证修复
const remaining = db
  .query(
    `
    SELECT COUNT(*) AS cnt
    FROM session s
    JOIN (
      SELECT session_id, MAX(time_created) AS max_msg
      FROM message
      GROUP BY session_id
    ) m ON m.session_id = s.id
    WHERE s.time_updated > m.max_msg + 3600000
      AND s.time_updated > s.time_created + 3600000
  `,
  )
  .get() as { cnt: number }

console.log(`修复后剩余偏离会话: ${remaining.cnt}\n`)

db.close()