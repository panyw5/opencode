import { defineConfig } from "vite"
import extensionKit from "@opencode-ai/extension-kit/vite"

export default defineConfig({
  plugins: extensionKit(),
})
