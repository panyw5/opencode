export function isShareableRendererAsset(file: string) {
  // Keep documents and scripts in the renderer's own build.
  return /^assets\/[A-Za-z0-9_-]+\.(?:woff2?|ttf|otf|svg|png|jpe?g|webp|gif|avif|ico)$/.test(file)
}
