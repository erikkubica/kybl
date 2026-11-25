/**
 * The desktop app. The shell (src/shell) holds the sidebar, Activity, Settings and the shared
 * dialogs; each browser pane (src/browser) shows one place. See docs/phase2-architecture.md §6.
 */
import { DialogsProvider } from "./shell/hooks/useDialogs";
import { AppShell } from "./shell/AppShell";
import "./styles.css";
import "./desktop/components/desktop.css";
import "./shell/components/shell.css";

export default function App() {
  return (
    <DialogsProvider>
      <AppShell />
    </DialogsProvider>
  );
}
