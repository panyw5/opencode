import { Duration, Effect, Fiber } from "effect"
import { IMRetention, type RetentionPolicy } from "./retention"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "im.retention-maintenance" })

export type MaintenanceHandle = {
  readonly tick: () => Promise<{ inbound: number; outbound: number }>
  readonly stop: () => Promise<void>
}

export async function start(
  policies: readonly RetentionPolicy[],
  cadence = Duration.days(1),
): Promise<MaintenanceHandle | undefined> {
  if (!policies.length) return undefined
  const tick = () => IMRetention.runtime.runPromise((service) => service.cleanup(policies))
  await tick().catch((error) =>
    log.error("IM initial retention cleanup failed; scheduling continues", { error: String(error) }),
  )
  const fiber = IMRetention.runtime.runFork((service) =>
    Effect.sleep(cadence).pipe(
      Effect.andThen(
        Effect.forever(
          service.cleanup(policies).pipe(
            Effect.tap((result) => Effect.sync(() => log.info("IM retention maintenance tick", result))),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("IM retention maintenance tick failed", { cause })),
            ),
            Effect.andThen(Effect.sleep(cadence)),
          ),
        ),
      ),
    ),
  )
  return {
    tick,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
  }
}

export * as IMRetentionMaintenance from "./retention-maintenance"
