import { describe, expect, test } from "bun:test"
import { PromptTemplate } from "../../src/session/prompt-template"

describe("session prompt template", () => {
  test("splits trusted shell blocks before any argument replacement", () => {
    expect(PromptTemplate.split("User !`printf trusted` output !`printf more`")).toEqual([
      { kind: "text", value: "User " },
      { kind: "shell", value: "printf trusted" },
      { kind: "text", value: " output " },
      { kind: "shell", value: "printf more" },
    ])
  })

  test("parses quoted and escaped command arguments without evaluating them", () => {
    const input = ['"hello world"', '"O\'Brien"', "'semi;$(touch marker);$&`tick`\\backslash'", "O\\'Brien", '""'].join(
      " ",
    )
    expect(PromptTemplate.argumentsList(input)).toEqual([
      "hello world",
      "O'Brien",
      "semi;$(touch marker);$&`tick`\\backslash",
      "O'Brien",
      "",
    ])
  })

  test("preserves callback replacement characters in prose and retains remainder behavior", () => {
    const input = `"one $&" two three`
    const args = PromptTemplate.argumentsList(input)
    const values = PromptTemplate.placeholders("$1 / $3 / $ARGUMENTS", input, args)
    expect(values.replace("$1 / $3 / $ARGUMENTS")).toBe(`one $& / three / ${input}`)
    const native = PromptTemplate.placeholders("$ARGUMENTS_COUNT", input, args)
    expect(native.hasArguments).toBe(false)
    expect(native.replace("$ARGUMENTS_COUNT")).toBe("$ARGUMENTS_COUNT")
  })

  test("binds values through context-aware shell expansions, not source text", () => {
    const input = `"hello world" 'semi;$(touch marker);$&' last`
    const args = PromptTemplate.argumentsList(input)
    const source = `printf '%s' $1; printf '%s' "$2"; printf '%s' '$3'; printf '%s' $ARGUMENTS`
    const binding = PromptTemplate.bindShell(source, input, args, "bash", "$1 $2 $3 $ARGUMENTS", "TEST_BIND")
    expect(binding.source).toContain('"${TEST_BIND_ARG_1}"')
    expect(binding.source).toContain('"${TEST_BIND_ARG_2}"')
    expect(binding.source).toContain("'\"${TEST_BIND_ARG_3}\"'")
    expect(binding.source).toContain('"${TEST_BIND_ARGUMENTS}"')
    expect(binding.source).not.toContain("touch marker")
    expect(binding.env).toMatchObject({
      TEST_BIND_ARG_1: "hello world",
      TEST_BIND_ARG_2: "semi;$(touch marker);$&",
      TEST_BIND_ARG_3: "last",
      TEST_BIND_ARGUMENTS: input,
    })
  })

  test("preserves escaped placeholders and shell variable names with suffixes", () => {
    const bound = PromptTemplate.bindShell(
      String.raw`printf '%s' \$1; printf '%s' "$1suffix"; printf '%s' "$ARGUMENTS_COUNT"`,
      "value",
      ["value"],
      "bash",
      "$1",
      "TEST_SUFFIX",
    )
    expect(bound.source).toBe(
      "printf '%s' \\$1; printf '%s' \"${TEST_SUFFIX_ARG_1}suffix\"; printf '%s' \"$ARGUMENTS_COUNT\"",
    )
    expect(bound.env).toEqual({ TEST_SUFFIX_ARG_1: "value" })
  })

  test("rejects placeholders in heredocs before a shell node can run", () => {
    expect(() => PromptTemplate.bindShell("cat <<'EOF'\n$1\nEOF", "value", ["value"], "bash")).toThrow(
      "heredocs are not supported",
    )
  })

  test("rejects unsafe shell argument interpolation and NUL before execution", () => {
    expect(() => PromptTemplate.bindShell("printf %s $1", "data", ["data"], "powershell")).toThrow(
      "not supported by powershell",
    )
    expect(() => PromptTemplate.bindShell("Write-Output $1", "data", ["data"], "pwsh")).toThrow("not supported by pwsh")
    expect(() => PromptTemplate.bindShell("echo $1", "data", ["data"], "cmd")).toThrow("not supported by cmd")
    expect(PromptTemplate.bindShell("Write-Output static", "data", [], "powershell", "$1").source).toBe(
      "Write-Output static",
    )
    expect(PromptTemplate.bindShell("Write-Output static", "data", [], "cmd", "$1").source).toBe("Write-Output static")
    expect(() => PromptTemplate.argumentsList("data\0")).toThrow("NUL byte")
  })
})
