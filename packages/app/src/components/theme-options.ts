const catppuccin = new Set(["catppuccin", "catppuccin-frappe", "catppuccin-macchiato"])

export function themeOptionIDs(ids: string[], mode: "light" | "dark") {
  return mode === "dark" ? ids : ids.filter((id) => !catppuccin.has(id) || id === "catppuccin")
}

export function themeOptionName(id: string, name: string, mode: "light" | "dark") {
  if (!catppuccin.has(id)) return name
  if (mode === "light") return "Catppuccin Latte"
  if (id === "catppuccin") return "Catppuccin Mocha"
  return name
}

export function themeOptionCurrent(id: string, mode: "light" | "dark") {
  return mode === "light" && catppuccin.has(id) ? "catppuccin" : id
}

// Selecting the shared Latte must not overwrite the user's preferred dark flavor.
export function themeOptionTarget(id: string, current: string, mode: "light" | "dark") {
  return mode === "light" && id === "catppuccin" && catppuccin.has(current) ? current : id
}
