import { assetToken } from "@/extension"

export const EXTENSION_ASSET_PREFIX = "/extension-asset/"

export function isExtensionAssetPath(pathname: string) {
  return pathname.startsWith(EXTENSION_ASSET_PREFIX)
}

export function hasExtensionAssetTokenURL(url: URL) {
  if (!isExtensionAssetPath(url.pathname)) return false
  const token = url.pathname.slice(EXTENSION_ASSET_PREFIX.length).split("/", 1)[0]
  return token.length > 0 && token === assetToken()
}
