export function safeModeFromURL(search: string, persistedDisabled: boolean) {
  const value = new URLSearchParams(search).get("extensions")
  if (value === "off") return { disabled: true, persist: true }
  if (value === "on") return { disabled: false, persist: true }
  return { disabled: persistedDisabled, persist: false }
}
