// @ts-nocheck
import * as mod from "./presentation-card"
import { DataProvider } from "../context/data"

const data = {
  session: [],
  session_status: {},
  session_diff: {},
  message: {},
  part: {},
}

const metadata = {
  artifactID: "story-artifact",
  mime: "image/svg+xml",
  width: 1280,
  height: 720,
  filename: "dashboard-preview.svg",
  size: 14336,
  sourcePath: "/project/dashboard-preview.svg",
  purpose: "verification",
  caption: "The rendered dashboard after the responsive layout pass.",
}

export default {
  title: "UI/PresentationCard",
  id: "components-presentation-card",
  component: mod.PresentationCard,
  tags: ["autodocs"],
}

const Wrapper = (props) => (
  <DataProvider
    data={data}
    directory="/project"
    loadPresentation={async () => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#20242a"/><circle cx="5" cy="4" r="2" fill="#8bd5ca"/><path d="M8 7h6" stroke="#f5bde6"/></svg>`], { type: "image/svg+xml" })}
    openPresentationSource={() => undefined}
  >
    {props.children}
  </DataProvider>
)

export const Completed = { render: () => <Wrapper><mod.PresentationCard sessionID="story" metadata={metadata} status="completed" /></Wrapper> }
export const Pending = { render: () => <Wrapper><mod.PresentationCard sessionID="story" input={{ filename: "dashboard-preview.svg" }} status="pending" /></Wrapper> }
export const Error = { render: () => <Wrapper><mod.PresentationCard sessionID="story" metadata={metadata} status="error" error="Preview generation failed" /></Wrapper> }
