import { Console } from "./console/Console"
import { Dashboard } from "./dashboard/Dashboard"

export default function App() {
  if (window.location.pathname.startsWith("/dashboard")) {
    return <Dashboard />
  }
  return <Console />
}
