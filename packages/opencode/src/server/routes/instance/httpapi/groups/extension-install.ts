import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ExtensionID } from "@/extension/schema"
import {
  OperationID,
  ExtensionOperationHeaders,
  ExtensionPrepareInput,
  ExtensionInstallInput,
  ExtensionUpdateInput,
  ExtensionCommitInput,
  ExtensionPreparedOperation,
  ExtensionInstallResult,
  ExtensionOperationStatus,
  ExtensionUnlockResult,
} from "@/extension/install-schema"
import { ConflictError, ForbiddenError, InvalidRequestError, UpstreamError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const ExtensionInstallPaths = {
  prepare: "/global/extension/prepare",
  install: "/global/extension/install",
  update: "/global/extension/:id/update",
  uninstall: "/global/extension/:id",
  operation: "/global/extension/operation/:operationId",
  unlock: "/global/extension/unlock",
} as const
const errors = [InvalidRequestError, ForbiddenError, ConflictError, HttpApiError.Gone, UpstreamError] as const

export const ExtensionInstallApi = HttpApi.make("extension-install").add(
  HttpApiGroup.make("extensionInstall")
    .add(
      HttpApiEndpoint.post("prepare", ExtensionInstallPaths.prepare, {
        payload: ExtensionPrepareInput,
        success: described(ExtensionPreparedOperation, "Prepared extension operation; confirmation required"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extensionInstallation.prepare",
          summary: "Prepare an extension installation operation",
        }),
      ),
      HttpApiEndpoint.post("install", ExtensionInstallPaths.install, {
        headers: ExtensionOperationHeaders,
        payload: ExtensionInstallInput,
        success: described(ExtensionInstallResult, "Installation commit result"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "extensionInstallation.install", summary: "Confirm extension installation" }),
      ),
      HttpApiEndpoint.post("update", ExtensionInstallPaths.update, {
        headers: ExtensionOperationHeaders,
        params: { id: ExtensionID },
        payload: ExtensionUpdateInput,
        success: described(ExtensionInstallResult, "Update commit result"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "extensionInstallation.update", summary: "Confirm extension update" }),
      ),
      HttpApiEndpoint.delete("uninstall", ExtensionInstallPaths.uninstall, {
        headers: ExtensionOperationHeaders,
        params: { id: ExtensionID },
        payload: ExtensionCommitInput,
        success: described(ExtensionInstallResult, "Removal commit result"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "extensionInstallation.uninstall", summary: "Confirm extension removal" }),
      ),
      HttpApiEndpoint.get("status", ExtensionInstallPaths.operation, {
        headers: ExtensionOperationHeaders,
        params: { operationId: OperationID },
        success: described(ExtensionOperationStatus, "Prepared or terminal operation status"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "extensionInstallation.status", summary: "Read extension operation status" }),
      ),
      HttpApiEndpoint.delete("cancel", ExtensionInstallPaths.operation, {
        headers: ExtensionOperationHeaders,
        params: { operationId: OperationID },
        success: described(ExtensionInstallResult, "Cancellation or already committed result"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extensionInstallation.cancel",
          summary: "Cancel an uncommitted extension operation",
        }),
      ),
      HttpApiEndpoint.post("unlock", ExtensionInstallPaths.unlock, {
        success: described(ExtensionUnlockResult, "Lease gates removed, kept as recent, or left untrusted"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extensionInstallation.unlock",
          summary: "Remove extension lease gates abandoned by interrupted processes",
        }),
      ),
    )
    .middleware(Authorization),
)
