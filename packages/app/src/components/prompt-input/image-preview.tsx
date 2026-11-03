import { AttachmentImagePreview } from "@opencode-ai/ui/attachment-image-preview"
import type { ImageAttachmentPart } from "@/context/prompt"

export function PromptImagePreview(props: { attachment: ImageAttachmentPart }) {
  return <AttachmentImagePreview src={props.attachment.dataUrl} filename={props.attachment.filename} />
}
