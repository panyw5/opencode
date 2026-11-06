export const shareImageLayouts = [
  { id: "phone", device: "phone", width: 750, viewport: 390, padding: 20 },
  { id: "phone-hd", device: "phone", width: 1170, viewport: 390, padding: 20 },
  { id: "ipad", device: "ipad", width: 1536, viewport: 768, padding: 32 },
  { id: "mac", device: "mac", width: 1920, viewport: 960, padding: 40 },
  { id: "mac-hd", device: "mac", width: 2400, viewport: 1200, padding: 48 },
] as const

export type ShareImageLayout = (typeof shareImageLayouts)[number]["id"]

export function shareImageLayout(id: ShareImageLayout) {
  const layout = shareImageLayouts.find((item) => item.id === id) ?? shareImageLayouts[1]
  const scale = layout.width / layout.viewport
  return {
    ...layout,
    fontSize: 16 * scale,
    paperStyle: {
      width: `${layout.width}px`,
      "--share-font-size": `${16 * scale}px`,
      "--share-padding": `${layout.padding * scale}px`,
    },
  }
}

export function sharePreviewScale(available: number, width: number) {
  return available > 0 ? Math.min(1, available / width) : 1
}
