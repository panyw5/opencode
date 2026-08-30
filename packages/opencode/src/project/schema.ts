import { Schema } from "effect"

import { withStatics } from "@opencode-ai/core/schema"
import { Identifier } from "@/id/id"

const projectIdSchema = Schema.String.pipe(Schema.brand("ProjectID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.make("global"),
    ascending: () => schema.make(Identifier.create("project", "ascending")),
  })),
)

const locationIdSchema = Schema.String.pipe(Schema.brand("LocationID"))

export type LocationID = typeof locationIdSchema.Type

export const LocationID = locationIdSchema.pipe(
  withStatics((schema: typeof locationIdSchema) => ({
    ascending: () => schema.make(Identifier.create("location", "ascending")),
  })),
)

const projectAliasIdSchema = Schema.String.pipe(Schema.brand("ProjectAliasID"))

export type ProjectAliasID = typeof projectAliasIdSchema.Type

export const ProjectAliasID = projectAliasIdSchema.pipe(
  withStatics((schema: typeof projectAliasIdSchema) => ({
    ascending: () => schema.make(Identifier.create("projectalias", "ascending")),
  })),
)
