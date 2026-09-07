import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { SetStoreFunction, Store } from "solid-js/store"
import type { State } from "./types"

export type SessionChildStore = [Store<State>, SetStoreFunction<State>]

export type SessionControllerDeps = {
  /** Stable identity used only for keyed state and comparisons. */
  key(directory: string): string
  isolated(directory: string): boolean
  /** SDK clients must be created from a logical directory, never an identity key. */
  sdk(directory: string): OpencodeClient
  child(directory: string): SessionChildStore
  current(directory: string, child: SessionChildStore, revision: number): boolean
  revision(directory: string): number
  pin(directory: string): void
  unpin(directory: string): void
}
