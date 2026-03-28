import { SandboxDiffProvider } from "./pierre"
import { useCaptureState } from "./shared"
import { Observatory } from "./Observatory"

export const App = () => {
  const state = useCaptureState()
  return (
    <SandboxDiffProvider>
      <Observatory state={state} />
    </SandboxDiffProvider>
  )
}
