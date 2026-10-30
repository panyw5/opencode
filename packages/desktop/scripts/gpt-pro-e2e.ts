// Compatibility entry for the canonical isolated live test. No original-session prompt replay,
// diagnostic-page mutation, draft clearing, model-picker masking or account migration is permitted.
if (process.argv.length > 2)
  throw Error("Legacy GPT-Pro E2E flags are retired. Use test:gpt-pro --live, --live-rich or --live-multipage; all use generated isolated fixtures.")
await import("./gpt-pro-auth-state-e2e")
