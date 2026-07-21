export async function convertWslPath(input: {
  path: string
  mode: "windows" | "linux"
  convert: (path: string, mode: "windows" | "linux") => Promise<string>
}) {
  try {
    const converted = await input.convert(input.path, input.mode)
    if (converted.trim()) return converted
  } catch (error) {
    throw new Error(`Could not convert ${input.path} to a ${input.mode} path for WSL: ${errorMessage(error)}`, {
      cause: error,
    })
  }

  throw new Error(`Could not convert ${input.path} to a ${input.mode} path for WSL: wslpath returned an empty path`)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
