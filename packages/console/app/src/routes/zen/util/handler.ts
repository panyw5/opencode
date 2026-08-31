import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull, lt, or, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { BillingTable, LiteTable, SubscriptionTable, UsageTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { getMonthlyBounds, getWeekBounds } from "@opencode-ai/console-core/util/date.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { Billing } from "@opencode-ai/console-core/billing.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { Subscription } from "@opencode-ai/console-core/subscription.js"
import { BlackData } from "@opencode-ai/console-core/black.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { ModelTable } from "@opencode-ai/console-core/schema/model.sql.js"
import { ProviderTable } from "@opencode-ai/console-core/schema/provider.sql.js"
import { logger } from "./logger"
import {
  AuthError,
  CreditsError,
  MonthlyLimitError,
  UserLimitError,
  ModelError,
  RateLimitError,
  FreeUsageLimitError,
  GoUsageLimitError,
  BlackUsageLimitError,
} from "./error"
import {
  buildCostChunk,
  createBodyConverter,
  createStreamPartConverter,
  createResponseConverter,
  UsageInfo,
} from "./provider/provider"
import { anthropicHelper } from "./provider/anthropic"
import { googleHelper } from "./provider/google"
import { openaiHelper } from "./provider/openai"
import { oaCompatHelper } from "./provider/openai-compatible"
import { createRateLimiter as createIpRateLimiter } from "./ipRateLimiter"
import { createRateLimiter as createKeyRateLimiter } from "./keyRateLimiter"
import { createTrialLimiter } from "./trialLimiter"
import { createStickyTracker } from "./stickyProviderTracker"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { Resource, waitUntil } from "@opencode-ai/console-resource"
import { i18n, type Key } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { createModelTpmLimiter } from "./modelTpmLimiter"
import { createModelTpsLimiter } from "./modelTpsLimiter"
import { cancelResponseBody, createUpstreamLifecycle, fetchWith429Retry, readProviderJson } from "./upstream"
import {
  canStreamRequestBody,
  prepareRequestBody,
  readRequestJson,
  responseIsStreaming,
  streamRequestBody,
} from "./requestBody"

type ZenData = Awaited<ReturnType<typeof ZenData.list>>
type PreparedBody = Awaited<ReturnType<typeof prepareRequestBody>>
type RetryOptions = {
  excludeProviders: string[]
  retryCount: number
}
type BillingSource = "anonymous" | "free" | "byok" | "subscription" | "lite" | "balance"

function resolve(text: string, params?: Record<string, string | number>) {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (raw, key) => {
    const value = params[key]
    if (value === undefined || value === null) return raw
    return String(value)
  })
}

export async function handler(
  input: APIEvent,
  opts: {
    format: ZenData.Format
    modelList: "lite" | "full"
    parseApiKey: (headers: Headers) => string | undefined
    parseModel: (url: string, body: any) => string
    parseVariant: (url: string, body: any) => string | undefined
    parseIsStream: (url: string, body: any) => boolean
  },
) {
  type AuthInfo = Awaited<ReturnType<typeof authenticate>>
  type ModelInfo = Awaited<ReturnType<typeof validateModel>>
  type ProviderInfo = Awaited<ReturnType<typeof selectProvider>>
  type CostInfo = ReturnType<typeof calculateCost>

  const MAX_FAILOVER_RETRIES = 3
  const MAX_429_RETRIES = 3
  const dict = i18n(localeFromRequest(input.request))
  const t = (key: Key, params?: Record<string, string | number>) => resolve(dict[key], params)
  const ADMIN_WORKSPACES = [
    "wrk_01K46JDFR0E75SG2Q8K172KF3Y", // anomaly
    "wrk_01K6W1A3VE0KMNVSCQT43BG2SX", // benchmark
    "wrk_01KKZDKDWCS1VTJF8QTX62DD50", // contributors
  ]
  let upstream: ReturnType<typeof createUpstreamLifecycle> | undefined
  let requestBody: PreparedBody | undefined
  let rawRequestBody: ReadableStream<Uint8Array> | undefined

  try {
    const url = input.request.url
    rawRequestBody = input.request.body ?? undefined
    if (!rawRequestBody) throw new Error("Missing request body")
    const lifecycle = createUpstreamLifecycle(input.request.signal)
    upstream = lifecycle
    requestBody = opts.format === "google" ? undefined : await prepareRequestBody(rawRequestBody, lifecycle.signal)
    const model = opts.format === "google" ? opts.parseModel(url, undefined) : (requestBody?.model ?? "")
    const googleIsStream = opts.format === "google" ? opts.parseIsStream(url, undefined) : false
    let bufferedBody: Promise<any> | undefined
    const getBufferedBody = () => {
      if (bufferedBody) return bufferedBody
      bufferedBody = requestBody ? requestBody.json() : readRequestJson(rawRequestBody!, lifecycle.signal)
      return bufferedBody
    }
    const rawIp = input.request.headers.get("x-real-ip") ?? ""
    const ip = rawIp.includes(":") ? rawIp.split(":").slice(0, 4).join(":") : rawIp
    const rawZenApiKey = opts.parseApiKey(input.request.headers)
    const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
    const sessionId = input.request.headers.get("x-opencode-session") ?? ""
    const requestId = input.request.headers.get("x-opencode-request") ?? ""
    const ocClient = input.request.headers.get("x-opencode-client") ?? ""
    const userAgent = input.request.headers.get("user-agent") ?? ""
    logger.metric({
      has_session: !!sessionId,
      has_request: !!requestId,
      has_client: !!ocClient,
      has_user_agent: !!userAgent,
    })
    const zenData = ZenData.list(opts.modelList)
    const modelInfo = validateModel(zenData, model)
    const trialLimiter = createTrialLimiter(modelInfo.trialProvider, ip)
    const trialProviders = await trialLimiter?.check()
    const rateLimiter = modelInfo.allowAnonymous
      ? createIpRateLimiter(modelInfo.id, modelInfo.rateLimit, ip, input.request)
      : createKeyRateLimiter(modelInfo.id, modelInfo.rateLimit, zenApiKey, input.request)
    await rateLimiter?.check()
    const authInfo = await authenticate(modelInfo, zenApiKey)
    const stickyId = sessionId ? sessionId : (authInfo?.workspaceID ?? ip)
    const stickyTracker = createStickyTracker(modelInfo.id, modelInfo.stickyProvider, stickyId)
    const stickyProvider = await stickyTracker?.get()
    const billingSource = validateBilling(authInfo, modelInfo)
    logger.metric({ source: billingSource })
    const modelTpmLimiter = createModelTpmLimiter(modelInfo.providers)
    const modelTpmLimits = await modelTpmLimiter?.check()
    const modelTpsLimiter = createModelTpsLimiter(modelInfo.providers)
    const modelTpsLimits = await modelTpsLimiter?.check()

    const retriableRequest = async (retry: RetryOptions = { excludeProviders: [], retryCount: 0 }) => {
      if (retry.retryCount > MAX_FAILOVER_RETRIES) throw new ModelError(t("zen.api.error.noProviderAvailable"))
      const providerInfo = selectProvider(
        model,
        zenData,
        authInfo,
        modelInfo,
        stickyId,
        trialProviders,
        retry,
        stickyProvider,
        modelTpmLimits,
        modelTpsLimits,
      )
      validateModelSettings(billingSource, authInfo)
      updateProviderKey(authInfo, providerInfo)
      logger.metric({
        provider: providerInfo.id,
        "provider.model": providerInfo.model,
      })

      const startTimestamp = Date.now()
      const direct = canStreamRequestBody({
        requestFormat: opts.format,
        providerFormat: providerInfo.format,
        providerModel: providerInfo.model,
        hasPayloadModifier: providerInfo.payloadModifier !== undefined,
        alreadyBuffered: bufferedBody !== undefined,
        contentLength: (() => {
          const raw = input.request.headers.get("content-length")
          if (raw === null) return undefined
          const value = Number(raw)
          return Number.isFinite(value) && value >= 0 ? value : 0
        })(),
      })
      logger.metric({ request_body_mode: direct ? "stream" : "buffer" })
      const body = direct ? undefined : await getBufferedBody()
      if (!direct) logger.metric({ "model.variant": opts.parseVariant(url, body) })
      const requestedIsStream = direct ? googleIsStream : opts.parseIsStream(url, body)
      const reqUrl = providerInfo.modifyUrl(providerInfo.api, requestedIsStream)
      const reqBody = direct
        ? opts.format === "google"
          ? streamRequestBody(rawRequestBody!, lifecycle.signal)
          : requestBody!.stream(providerInfo.model, providerInfo.format === "oa-compat")
        : JSON.stringify(
            providerInfo.modifyBody({
              ...createBodyConverter(opts.format, providerInfo.format)(body),
              model: providerInfo.model,
              ...(() => {
                const replacer = (obj: Record<string, any>): Record<string, any> =>
                  Object.fromEntries(
                    Object.entries(obj).flatMap(([k, v]) => {
                      if (Array.isArray(v)) return [[k, v]]
                      if (v !== null && typeof v === "object") return [[k, replacer(v)]]
                      if (typeof v === "string") {
                        if (v === "$workspace") return authInfo?.workspaceID ? [[k, authInfo?.workspaceID]] : []
                        if (v === "$user") return stickyId ? [[k, stickyId]] : []
                        if (v.startsWith("$header.")) {
                          const headerValue = input.request.headers.get(v.slice(8))
                          return headerValue ? [[k, headerValue]] : []
                        }
                      }
                      return [[k, v]]
                    }),
                  )
                return replacer(providerInfo.payloadModifier ?? {})
              })(),
            }),
          )
      const init: RequestInit = {
        method: "POST",
        headers: (() => {
          const headers = new Headers(input.request.headers)
          providerInfo.modifyHeaders(headers, providerInfo.apiKey, stickyId)
          Object.entries(providerInfo.headerMappings ?? {}).forEach(([k, v]) => {
            headers.set(k, headers.get(v)!)
          })
          headers.delete("host")
          headers.delete("content-length")
          headers.delete("x-opencode-request")
          headers.delete("x-opencode-session")
          headers.delete("x-opencode-project")
          headers.delete("x-opencode-client")
          return headers
        })(),
        body: reqBody,
        signal: lifecycle.signal,
      }
      const res = direct
        ? await fetch(reqUrl, init)
        : await fetchWith429Retry(reqUrl, init, { maxRetries: MAX_429_RETRIES })
      const responseIsStream = responseIsStreaming(opts.format, googleIsStream, res.headers.get("content-type"))
      logger.metric({ is_stream: responseIsStream })

      if (res.status !== 200) logger.metric({ "llm.error.code": res.status })

      // Try another provider => stop retrying if using fallback provider
      if (
        res.status !== 200 &&
        // ie. 400 error is usually provider error like malformed request
        res.status !== 400 &&
        // ie. openai 404 error: Item with id 'msg_0ead8b004a3b165d0069436a6b6834819896da85b63b196a3f' not found.
        !(modelInfo.id.startsWith("gpt-") && res.status === 404) &&
        // ie. cannot change codex model providers mid-session
        modelInfo.stickyProvider !== "strict" &&
        billingSource !== "byok" &&
        modelInfo.fallbackProvider &&
        providerInfo.id !== modelInfo.fallbackProvider &&
        !direct
      ) {
        await cancelResponseBody(res.body, lifecycle.signal)
        return retriableRequest({
          excludeProviders: [...retry.excludeProviders, providerInfo.id],
          retryCount: retry.retryCount + 1,
        })
      }

      return { providerInfo, res, startTimestamp, isStream: responseIsStream }
    }

    const { providerInfo, res, startTimestamp, isStream } = await retriableRequest()

    // Store sticky provider
    if (res.status === 200) await stickyTracker?.set(providerInfo.id)

    // Temporarily change 404 to 400 status code b/c solid start automatically override 404 response
    const resStatus = res.status === 404 ? 400 : res.status

    // Scrub response headers
    const resHeaders = new Headers()
    const keepHeaders = ["content-type", "cache-control"]
    for (const [k, v] of res.headers.entries()) {
      if (keepHeaders.includes(k.toLowerCase())) {
        resHeaders.set(k, v)
      }
    }
    logger.debug("STATUS: " + res.status)

    // Handle non-streaming response
    if (!isStream || res.status !== 200) {
      const json = await readProviderJson(res)
      lifecycle.complete()
      await rateLimiter?.track()
      if (json.usage) {
        const usageInfo = providerInfo.normalizeUsage(json.usage)
        const costInfo = calculateCost(modelInfo, usageInfo)
        await trialLimiter?.track(usageInfo)
        await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
        await trackUsage(sessionId, billingSource, authInfo, modelInfo, providerInfo, usageInfo, costInfo)
        await reload(billingSource, authInfo, costInfo)
        json.cost = calculateOccurredCost(billingSource, costInfo)
      }
      if (json.error?.message) {
        json.error.message = `Error from provider${providerInfo.displayName ? ` (${providerInfo.displayName})` : ""}: ${json.error.message}`
      }

      const responseConverter = createResponseConverter(providerInfo.format, opts.format)
      const body = JSON.stringify(responseConverter(json))
      logger.metric({ response_length: body.length })
      return new Response(body, {
        status: resStatus,
        statusText: res.statusText,
        headers: resHeaders,
      })
    }

    // Handle streaming response
    const streamConverter = createStreamPartConverter(providerInfo.format, opts.format)
    const usageParser = providerInfo.createUsageParser()
    const binaryDecoder = providerInfo.createBinaryStreamDecoder()
    if (!res.body) {
      lifecycle.complete()
      throw new Error("Provider stream response body is missing")
    }
    let downstreamCancelled = false
    let finalizeUsage: ((timestampLastByte: number) => Promise<Uint8Array | undefined>) | undefined
    const stream = new ReadableStream({
      start(c) {
        const reader = res.body!.getReader()
        const ready = lifecycle.attach(reader)
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()

        let buffer = ""
        let responseLength = 0
        let timestampFirstByte = 0
        let usageFinalization: Promise<Uint8Array | undefined> | undefined

        finalizeUsage = (timestampLastByte) => {
          if (usageFinalization) return usageFinalization
          usageFinalization = (async () => {
            await rateLimiter?.track()
            const usage = usageParser.retrieve()
            if (!usage) return
            const usageInfo = providerInfo.normalizeUsage(usage)
            const costInfo = calculateCost(modelInfo, usageInfo)
            await trialLimiter?.track(usageInfo)
            await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
            await modelTpsLimiter?.track(
              providerInfo.id,
              providerInfo.model,
              providerInfo.tpsGoal,
              timestampFirstByte,
              timestampLastByte,
              usageInfo,
            )
            await trackUsage(sessionId, billingSource, authInfo, modelInfo, providerInfo, usageInfo, costInfo)
            await reload(billingSource, authInfo, costInfo)
            return encoder.encode(buildCostChunk(opts.format, calculateOccurredCost(billingSource, costInfo)))
          })().catch((error) => {
            logger.metric({ "error.type": "UsageFinalizationError" })
            throw error
          })
          waitUntil(usageFinalization.catch(() => undefined))
          return usageFinalization
        }

        async function pump(): Promise<void> {
          try {
            if (lifecycle.cancelled) {
              c.error(new DOMException("Request aborted", "AbortError"))
              void ready.then(() => finalizeUsage!(Date.now())).catch(() => undefined)
              return
            }
            await ready
            if (lifecycle.cancelled) {
              c.error(new DOMException("Request aborted", "AbortError"))
              void finalizeUsage!(Date.now()).catch(() => undefined)
              return
            }
            while (!lifecycle.cancelled && !downstreamCancelled) {
              const { done, value: rawValue } = await reader.read()
              if (done) {
                if (lifecycle.cancelled) {
                  c.error(new DOMException("Request aborted", "AbortError"))
                  void finalizeUsage!(Date.now()).catch(() => undefined)
                  return
                }
                lifecycle.complete()
                if (downstreamCancelled) return
                const timestampLastByte = Date.now()
                logger.metric({
                  response_length: responseLength,
                  "timestamp.last_byte": timestampLastByte,
                })
                const costChunk = await finalizeUsage!(timestampLastByte)
                if (downstreamCancelled) return
                if (costChunk) c.enqueue(costChunk)
                c.close()
                return
              }

              if (responseLength === 0) {
                timestampFirstByte = Date.now()
                logger.metric({
                  time_to_first_byte: timestampFirstByte - startTimestamp,
                  "timestamp.first_byte": timestampFirstByte,
                })
              }

              const value = binaryDecoder ? binaryDecoder(rawValue) : rawValue
              if (!value) continue

              responseLength += value.length
              buffer += decoder.decode(value, { stream: true })

              const parts = buffer.split(providerInfo.streamSeparator)
              buffer = parts.pop() ?? ""

              for (let part of parts) {
                part = part.trim()
                usageParser.parse(part)

                if (providerInfo.format !== opts.format) {
                  part = streamConverter(part)
                  c.enqueue(encoder.encode(part + "\n\n"))
                }
              }

              if (providerInfo.format === opts.format) {
                c.enqueue(value)
              }
            }
            if (lifecycle.cancelled && !downstreamCancelled) {
              c.error(new DOMException("Request aborted", "AbortError"))
              void finalizeUsage!(Date.now()).catch(() => undefined)
            }
          } catch (error) {
            if (downstreamCancelled) return
            if (lifecycle.cancelled) {
              c.error(new DOMException("Request aborted", "AbortError"))
              void finalizeUsage!(Date.now()).catch(() => undefined)
              return
            }
            c.error(new Error("Provider stream failed"))
            logger.metric({ "error.type": "ProviderStreamError" })
            void lifecycle.cancel(error)
            void finalizeUsage!(Date.now()).catch(() => undefined)
          }
        }

        return pump()
      },
      cancel(reason) {
        downstreamCancelled = true
        void finalizeUsage?.(Date.now()).catch(() => undefined)
        return lifecycle.cancel(reason)
      },
    })
    return new Response(stream, {
      status: resStatus,
      statusText: res.statusText,
      headers: resHeaders,
    })
  } catch (error: any) {
    void requestBody?.cancel(error).catch(() => {})
    if (!requestBody) void rawRequestBody?.cancel(error).catch(() => {})
    const abortedByCaller = input.request.signal.aborted || upstream?.abortedByCaller
    await upstream?.cancel(error)
    if (abortedByCaller) {
      return new Response(null, { status: 499 })
    }

    logger.metric({
      "error.type": error?.constructor?.name ?? "UnknownError",
    })

    // Note: both top level "type" and "error.type" fields are used by the @ai-sdk/anthropic client to render the error message.
    if (
      error instanceof AuthError ||
      error instanceof CreditsError ||
      error instanceof MonthlyLimitError ||
      error instanceof UserLimitError ||
      error instanceof ModelError
    )
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: error.constructor.name, message: error.message },
        }),
        { status: 401 },
      )

    if (
      error instanceof RateLimitError ||
      error instanceof FreeUsageLimitError ||
      error instanceof GoUsageLimitError ||
      error instanceof BlackUsageLimitError
    ) {
      const headers = new Headers()
      if (error.retryAfter) {
        headers.set("retry-after", String(error.retryAfter))
      }
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: error.constructor.name,
            message: error.message,
          },
          metadata:
            error instanceof GoUsageLimitError
              ? {
                  workspace: error.workspace,
                  limitName: error.limitName,
                }
              : {},
        }),
        { status: 429, headers },
      )
    }

    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "error",
          message: "Internal server error",
        },
      }),
      { status: 500 },
    )
  }

  function validateModel(zenData: ZenData, reqModel: string) {
    if (!(reqModel in zenData.models)) throw new ModelError(t("zen.api.error.modelNotSupported", { model: reqModel }))

    const modelId = reqModel
    const modelData = Array.isArray(zenData.models[modelId])
      ? zenData.models[modelId].find((model) => opts.format === model.formatFilter)
      : zenData.models[modelId]

    if (!modelData)
      throw new ModelError(
        t("zen.api.error.modelFormatNotSupported", {
          model: reqModel,
          format: opts.format,
        }),
      )

    if (modelData.trialEnded)
      throw new ModelError(
        `${t("zen.api.error.trialEnded", {
          model: modelData.name,
          link: "https://opencode.ai/go",
        })}`,
      )

    logger.metric({ model: modelId })

    return { id: modelId, ...modelData }
  }

  function selectProvider(
    reqModel: string,
    zenData: ZenData,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    stickyId: string,
    trialProviders: string[] | undefined,
    retry: RetryOptions,
    stickyProvider: string | undefined,
    modelTpmLimits: Record<string, number> | undefined,
    modelTpsLimits: Record<string, boolean> | undefined,
  ) {
    const modelProvider = (() => {
      // Byok is top priority b/c if user set their own API key, we should use it
      // instead of using the sticky provider for the same session
      if (authInfo?.provider?.credentials) {
        return modelInfo.providers.find((provider) => provider.id === modelInfo.byokProvider)
      }

      // Always use the same provider for the same session
      if (stickyProvider && retry.retryCount === 0) {
        const provider = modelInfo.providers.find((provider) => provider.id === stickyProvider)
        if (provider) return provider
      }

      if (trialProviders && retry.retryCount === 0) {
        const trialProvider = trialProviders[Math.floor(Math.random() * trialProviders.length)]
        const provider = modelInfo.providers.find((provider) => provider.id === trialProvider)
        if (provider) return provider
      }

      if (retry.retryCount !== MAX_FAILOVER_RETRIES) {
        let topPriority = Infinity
        const providers = modelInfo.providers
          .filter((provider) => !provider.disabled)
          .filter((provider) => provider.weight !== 0)
          .filter((provider) => !retry.excludeProviders.includes(provider.id))
          .filter((provider) => {
            if (!provider.tpmLimit) return true
            const usage = modelTpmLimits?.[`${provider.id}/${provider.model}`] ?? 0
            return usage < provider.tpmLimit * 1_000_000
          })
          .filter((provider) => {
            if (!provider.tpsGoal) return true
            const isLowTps = modelTpsLimits?.[`${provider.id}/${provider.model}/${provider.tpsGoal}`] ?? false
            return !isLowTps
          })
          .map((provider) => {
            topPriority = Math.min(topPriority, provider.priority)
            return provider
          })
          .filter((p) => p.priority <= topPriority)
          .flatMap((provider) => Array<typeof provider>(provider.weight).fill(provider))

        // Use the last 4 characters of session ID to select a provider
        let h = 0
        const l = stickyId.length
        for (let i = l - 4; i < l; i++) {
          h = (h * 31 + stickyId.charCodeAt(i)) | 0 // 32-bit int
        }
        const index = (h >>> 0) % providers.length // make unsigned + range 0..length-1
        const provider = providers[index || 0]
        if (provider) return provider
      }

      // fallback provider
      return modelInfo.providers.find((provider) => provider.id === modelInfo.fallbackProvider)
    })()

    if (!modelProvider) throw new ModelError(t("zen.api.error.noProviderAvailable"))
    if (!(modelProvider.id in zenData.providers))
      throw new ModelError(t("zen.api.error.providerNotSupported", { provider: modelProvider.id }))

    return {
      ...modelProvider,
      ...zenData.providers[modelProvider.id],
      ...(() => {
        const providerProps = zenData.providers[modelProvider.id]
        const format = providerProps.format
        const opts = {
          reqModel,
          providerModel: modelProvider.model,
          adjustCacheUsage: providerProps.adjustCacheUsage,
          workspaceID: authInfo?.workspaceID,
        }
        if (format === "anthropic") return anthropicHelper(opts)
        if (format === "google") return googleHelper(opts)
        if (format === "openai") return openaiHelper(opts)
        return oaCompatHelper(opts)
      })(),
    }
  }

  async function authenticate(modelInfo: ModelInfo, zenApiKey?: string) {
    if (!zenApiKey) {
      if (modelInfo.allowAnonymous) return
      throw new AuthError(t("zen.api.error.missingApiKey"))
    }

    const data = await Database.use((tx) =>
      tx
        .select({
          apiKey: KeyTable.id,
          workspaceID: KeyTable.workspaceID,
          billing: {
            balance: BillingTable.balance,
            paymentMethodID: BillingTable.paymentMethodID,
            monthlyLimit: BillingTable.monthlyLimit,
            monthlyUsage: BillingTable.monthlyUsage,
            timeMonthlyUsageUpdated: BillingTable.timeMonthlyUsageUpdated,
            reloadTrigger: BillingTable.reloadTrigger,
            timeReloadLockedTill: BillingTable.timeReloadLockedTill,
            subscription: BillingTable.subscription,
            lite: BillingTable.lite,
          },
          user: {
            id: UserTable.id,
            monthlyLimit: UserTable.monthlyLimit,
            monthlyUsage: UserTable.monthlyUsage,
            timeMonthlyUsageUpdated: UserTable.timeMonthlyUsageUpdated,
          },
          black: {
            id: SubscriptionTable.id,
            rollingUsage: SubscriptionTable.rollingUsage,
            fixedUsage: SubscriptionTable.fixedUsage,
            timeRollingUpdated: SubscriptionTable.timeRollingUpdated,
            timeFixedUpdated: SubscriptionTable.timeFixedUpdated,
          },
          lite: {
            id: LiteTable.id,
            timeCreated: LiteTable.timeCreated,
            rollingUsage: LiteTable.rollingUsage,
            weeklyUsage: LiteTable.weeklyUsage,
            monthlyUsage: LiteTable.monthlyUsage,
            timeRollingUpdated: LiteTable.timeRollingUpdated,
            timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
            timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
          },
          provider: {
            credentials: ProviderTable.credentials,
          },
          timeDisabled: ModelTable.timeCreated,
        })
        .from(KeyTable)
        .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, KeyTable.workspaceID))
        .innerJoin(BillingTable, eq(BillingTable.workspaceID, KeyTable.workspaceID))
        .innerJoin(UserTable, and(eq(UserTable.workspaceID, KeyTable.workspaceID), eq(UserTable.id, KeyTable.userID)))
        .leftJoin(ModelTable, and(eq(ModelTable.workspaceID, KeyTable.workspaceID), eq(ModelTable.model, modelInfo.id)))
        .leftJoin(
          ProviderTable,
          modelInfo.byokProvider
            ? and(
                eq(ProviderTable.workspaceID, KeyTable.workspaceID),
                eq(ProviderTable.provider, modelInfo.byokProvider),
              )
            : sql`false`,
        )
        .leftJoin(
          SubscriptionTable,
          and(
            eq(SubscriptionTable.workspaceID, KeyTable.workspaceID),
            eq(SubscriptionTable.userID, KeyTable.userID),
            isNull(SubscriptionTable.timeDeleted),
          ),
        )
        .leftJoin(
          LiteTable,
          and(
            eq(LiteTable.workspaceID, KeyTable.workspaceID),
            eq(LiteTable.userID, KeyTable.userID),
            isNull(LiteTable.timeDeleted),
          ),
        )
        .where(and(eq(KeyTable.key, zenApiKey), isNull(KeyTable.timeDeleted)))
        .then((rows) => rows[0]),
    )

    if (!data) throw new AuthError(t("zen.api.error.invalidApiKey"))
    if (
      modelInfo.id.startsWith("alpha-") &&
      Resource.App.stage === "production" &&
      !ADMIN_WORKSPACES.includes(data.workspaceID)
    )
      throw new AuthError(t("zen.api.error.modelNotSupported", { model: modelInfo.id }))

    logger.metric({
      authenticated: true,
      ...(() => {
        if (data.billing.subscription)
          return {
            isSubscription: true,
            subscription: data.billing.subscription.plan,
          }
        if (data.billing.lite)
          return {
            isSubscription: true,
            subscription: "lite",
          }
        return {}
      })(),
    })

    return {
      apiKeyId: data.apiKey,
      workspaceID: data.workspaceID,
      billing: data.billing,
      user: data.user,
      black: data.black,
      lite: data.lite,
      provider: data.provider,
      isFree: ADMIN_WORKSPACES.includes(data.workspaceID),
      isDisabled: !!data.timeDisabled,
    }
  }

  function validateBilling(authInfo: AuthInfo, modelInfo: ModelInfo): BillingSource {
    if (!authInfo) return "anonymous"
    if (authInfo.provider?.credentials) return "byok"
    if (authInfo.isFree) return "free"
    if (modelInfo.allowAnonymous) return "free"

    const formatRetryTime = (seconds: number) => {
      const days = Math.floor(seconds / 86400)
      if (days >= 1) return `${days} day${days > 1 ? "s" : ""}`
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.ceil((seconds % 3600) / 60)
      if (hours >= 1) return `${hours}hr ${minutes}min`
      return `${minutes}min`
    }

    // Validate black subscription billing
    if (authInfo.billing.subscription && authInfo.black) {
      try {
        const sub = authInfo.black
        const plan = authInfo.billing.subscription.plan

        // Check weekly limit
        if (sub.fixedUsage && sub.timeFixedUpdated) {
          const blackData = BlackData.getLimits({ plan })
          const result = Subscription.analyzeWeeklyUsage({
            limit: blackData.fixedLimit,
            usage: sub.fixedUsage,
            timeUpdated: sub.timeFixedUpdated,
          })
          if (result.status === "rate-limited")
            throw new BlackUsageLimitError(
              t("zen.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
              }),
              result.resetInSec,
            )
        }

        // Check rolling limit
        if (sub.rollingUsage && sub.timeRollingUpdated) {
          const blackData = BlackData.getLimits({ plan })
          const result = Subscription.analyzeRollingUsage({
            limit: blackData.rollingLimit,
            window: blackData.rollingWindow,
            usage: sub.rollingUsage,
            timeUpdated: sub.timeRollingUpdated,
          })
          if (result.status === "rate-limited")
            throw new BlackUsageLimitError(
              t("zen.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
              }),
              result.resetInSec,
            )
        }

        return "subscription"
      } catch (e) {
        if (!authInfo.billing.subscription.useBalance) throw e
      }
    }

    // Validate lite subscription billing
    if (opts.modelList === "lite" && authInfo.billing.lite && authInfo.lite) {
      try {
        const consoleGoUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/go`
        const sub = authInfo.lite
        const liteData = LiteData.getLimits()

        // Check weekly limit
        if (sub.weeklyUsage && sub.timeWeeklyUpdated) {
          const result = Subscription.analyzeWeeklyUsage({
            limit: liteData.weeklyLimit,
            usage: sub.weeklyUsage,
            timeUpdated: sub.timeWeeklyUpdated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionWeeklyLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "weekly",
              result.resetInSec,
            )
        }

        // Check monthly limit
        if (sub.monthlyUsage && sub.timeMonthlyUpdated) {
          const result = Subscription.analyzeMonthlyUsage({
            limit: liteData.monthlyLimit,
            usage: sub.monthlyUsage,
            timeUpdated: sub.timeMonthlyUpdated,
            timeSubscribed: sub.timeCreated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionMonthlyLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "monthly",
              result.resetInSec,
            )
        }

        // Check rolling limit
        if (sub.rollingUsage && sub.timeRollingUpdated) {
          const result = Subscription.analyzeRollingUsage({
            limit: liteData.rollingLimit,
            window: liteData.rollingWindow,
            usage: sub.rollingUsage,
            timeUpdated: sub.timeRollingUpdated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionRollingLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "5 hour",
              result.resetInSec,
            )
        }

        return "lite"
      } catch (e) {
        if (!authInfo.billing.lite.useBalance) throw e
      }
    }

    // Validate pay as you go billing
    const billing = authInfo.billing
    const billingUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/billing`
    const membersUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/members`
    if (!billing.paymentMethodID && billing.balance <= 0)
      throw new CreditsError(t("zen.api.error.noPaymentMethod", { billingUrl }))
    if (billing.balance <= 0) throw new CreditsError(t("zen.api.error.insufficientBalance", { billingUrl }))

    const now = new Date()
    const currentYear = now.getUTCFullYear()
    const currentMonth = now.getUTCMonth()
    if (
      billing.monthlyLimit &&
      billing.monthlyUsage &&
      billing.timeMonthlyUsageUpdated &&
      billing.monthlyUsage >= centsToMicroCents(billing.monthlyLimit * 100) &&
      currentYear === billing.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === billing.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new MonthlyLimitError(
        t("zen.api.error.workspaceMonthlyLimitReached", {
          amount: billing.monthlyLimit,
          billingUrl,
        }),
      )

    if (
      authInfo.user.monthlyLimit &&
      authInfo.user.monthlyUsage &&
      authInfo.user.timeMonthlyUsageUpdated &&
      authInfo.user.monthlyUsage >= centsToMicroCents(authInfo.user.monthlyLimit * 100) &&
      currentYear === authInfo.user.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === authInfo.user.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new UserLimitError(
        t("zen.api.error.userMonthlyLimitReached", {
          amount: authInfo.user.monthlyLimit,
          membersUrl,
        }),
      )

    return "balance"
  }

  function validateModelSettings(billingSource: BillingSource, authInfo: AuthInfo) {
    if (billingSource === "lite") return
    if (billingSource === "anonymous") return
    if (authInfo!.isDisabled) throw new ModelError(t("zen.api.error.modelDisabled"))
  }

  function updateProviderKey(authInfo: AuthInfo, providerInfo: ProviderInfo) {
    if (!authInfo?.provider?.credentials) return
    providerInfo.apiKey = authInfo.provider.credentials
  }

  function calculateCost(modelInfo: ModelInfo, usageInfo: UsageInfo) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo

    const modelCost =
      modelInfo.cost200K &&
      inputTokens + (cacheReadTokens ?? 0) + (cacheWrite5mTokens ?? 0) + (cacheWrite1hTokens ?? 0) > 200_000
        ? modelInfo.cost200K
        : modelInfo.cost

    const inputCost = modelCost.input * inputTokens * 100
    const outputCost = modelCost.output * outputTokens * 100
    const cacheReadCost = (() => {
      if (!cacheReadTokens) return undefined
      if (!modelCost.cacheRead) return undefined
      return modelCost.cacheRead * cacheReadTokens * 100
    })()
    const cacheWrite5mCost = (() => {
      if (!cacheWrite5mTokens) return undefined
      if (!modelCost.cacheWrite5m) return undefined
      return modelCost.cacheWrite5m * cacheWrite5mTokens * 100
    })()
    const cacheWrite1hCost = (() => {
      if (!cacheWrite1hTokens) return undefined
      if (!modelCost.cacheWrite1h) return undefined
      return modelCost.cacheWrite1h * cacheWrite1hTokens * 100
    })()
    const totalCostInCent =
      inputCost + outputCost + (cacheReadCost ?? 0) + (cacheWrite5mCost ?? 0) + (cacheWrite1hCost ?? 0)
    return {
      totalCostInCent,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWrite5mCost,
      cacheWrite1hCost,
    }
  }

  function calculateOccurredCost(billingSource: BillingSource, costInfo: CostInfo) {
    return billingSource === "balance" ? (costInfo.totalCostInCent / 100).toFixed(8) : "0"
  }

  async function trackUsage(
    sessionId: string,
    billingSource: BillingSource,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    providerInfo: ProviderInfo,
    usageInfo: UsageInfo,
    costInfo: CostInfo,
  ) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo
    const { totalCostInCent, inputCost, outputCost, cacheReadCost, cacheWrite5mCost, cacheWrite1hCost } = costInfo

    logger.metric({
      "tokens.input": inputTokens,
      "tokens.output": outputTokens,
      "tokens.reasoning": reasoningTokens,
      "tokens.cache_read": cacheReadTokens,
      "tokens.cache_write_5m": cacheWrite5mTokens,
      "tokens.cache_write_1h": cacheWrite1hTokens,
      "cost.input.microcents": centsToMicroCents(inputCost),
      "cost.output.microcents": centsToMicroCents(outputCost),
      "cost.cache_read.microcents": cacheReadCost ? centsToMicroCents(cacheReadCost) : undefined,
      "cost.cache_write.microcents": cacheWrite5mCost ? centsToMicroCents(cacheWrite5mCost) : undefined,
      "cost.total.microcents": centsToMicroCents(totalCostInCent),
      // deprecated - remove after May 20, 2026
      "cost.input": Math.round(inputCost),
      "cost.output": Math.round(outputCost),
      "cost.cache_read": cacheReadCost ? Math.round(cacheReadCost) : undefined,
      "cost.cache_write_5m": cacheWrite5mCost ? Math.round(cacheWrite5mCost) : undefined,
      "cost.cache_write_1h": cacheWrite1hCost ? Math.round(cacheWrite1hCost) : undefined,
      "cost.total": Math.round(totalCostInCent),
    })

    if (billingSource === "anonymous") return
    authInfo = authInfo!

    const cost = centsToMicroCents(totalCostInCent)
    await Database.use((db) =>
      Promise.all([
        db.insert(UsageTable).values({
          workspaceID: authInfo.workspaceID,
          id: Identifier.create("usage"),
          model: modelInfo.id,
          provider: providerInfo.id,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
          cost,
          keyID: authInfo.apiKeyId,
          sessionID: sessionId.substring(0, 30),
          enrichment: (() => {
            if (billingSource === "subscription") return { plan: "sub" }
            if (billingSource === "byok") return { plan: "byok" }
            if (billingSource === "lite") return { plan: "lite" }
            return undefined
          })(),
        }),
        db
          .update(KeyTable)
          .set({ timeUsed: sql`now()` })
          .where(and(eq(KeyTable.workspaceID, authInfo.workspaceID), eq(KeyTable.id, authInfo.apiKeyId))),
        ...(() => {
          if (billingSource === "subscription") {
            const plan = authInfo.billing.subscription!.plan
            const black = BlackData.getLimits({ plan })
            const week = getWeekBounds(new Date())
            const rollingWindowSeconds = black.rollingWindow * 3600
            return [
              db
                .update(SubscriptionTable)
                .set({
                  fixedUsage: sql`
              CASE
                WHEN ${SubscriptionTable.timeFixedUpdated} >= ${week.start} THEN ${SubscriptionTable.fixedUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeFixedUpdated: sql`now()`,
                  rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.rollingUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.timeRollingUpdated}
                ELSE now()
              END
            `,
                })
                .where(
                  and(
                    eq(SubscriptionTable.workspaceID, authInfo.workspaceID),
                    eq(SubscriptionTable.userID, authInfo.user.id),
                  ),
                ),
            ]
          }
          if (billingSource === "lite") {
            const lite = LiteData.getLimits()
            const week = getWeekBounds(new Date())
            const month = getMonthlyBounds(new Date(), authInfo.lite!.timeCreated)
            const rollingWindowSeconds = lite.rollingWindow * 3600
            return [
              db
                .update(LiteTable)
                .set({
                  monthlyUsage: sql`
              CASE
                WHEN ${LiteTable.timeMonthlyUpdated} >= ${month.start} THEN ${LiteTable.monthlyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeMonthlyUpdated: sql`now()`,
                  weeklyUsage: sql`
              CASE
                WHEN ${LiteTable.timeWeeklyUpdated} >= ${week.start} THEN ${LiteTable.weeklyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeWeeklyUpdated: sql`now()`,
                  rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.rollingUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.timeRollingUpdated}
                ELSE now()
              END
            `,
                })
                .where(and(eq(LiteTable.workspaceID, authInfo.workspaceID), eq(LiteTable.userID, authInfo.user.id))),
            ]
          }

          return [
            db
              .update(BillingTable)
              .set({
                balance:
                  billingSource === "free" || billingSource === "byok"
                    ? sql`${BillingTable.balance} - ${0}`
                    : sql`${BillingTable.balance} - ${cost}`,
                monthlyUsage: sql`
              CASE
                WHEN MONTH(${BillingTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${BillingTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${BillingTable.monthlyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                timeMonthlyUsageUpdated: sql`now()`,
              })
              .where(eq(BillingTable.workspaceID, authInfo.workspaceID)),
            db
              .update(UserTable)
              .set({
                monthlyUsage: sql`
              CASE
                WHEN MONTH(${UserTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${UserTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${UserTable.monthlyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                timeMonthlyUsageUpdated: sql`now()`,
              })
              .where(and(eq(UserTable.workspaceID, authInfo.workspaceID), eq(UserTable.id, authInfo.user.id))),
          ]
        })(),
      ]),
    )

    return { costInMicroCents: cost }
  }

  async function reload(billingSource: BillingSource, authInfo: AuthInfo, costInfo: CostInfo) {
    if (billingSource !== "balance") return
    authInfo = authInfo!

    const reloadTrigger = centsToMicroCents((authInfo.billing.reloadTrigger ?? Billing.RELOAD_TRIGGER) * 100)
    if (authInfo.billing.balance - costInfo.totalCostInCent >= reloadTrigger) return
    if (authInfo.billing.timeReloadLockedTill && authInfo.billing.timeReloadLockedTill > new Date()) return

    const lock = await Database.use((tx) =>
      tx
        .update(BillingTable)
        .set({
          timeReloadLockedTill: sql`now() + interval 1 minute`,
        })
        .where(
          and(
            eq(BillingTable.workspaceID, authInfo.workspaceID),
            eq(BillingTable.reload, true),
            lt(BillingTable.balance, reloadTrigger),
            or(isNull(BillingTable.timeReloadLockedTill), lt(BillingTable.timeReloadLockedTill, sql`now()`)),
          ),
        ),
    )
    if (lock.rowsAffected === 0) return

    await Actor.provide("system", { workspaceID: authInfo.workspaceID }, async () => {
      await Billing.reload()
    })
  }
}
