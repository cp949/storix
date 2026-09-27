import { useState } from "react";
import type { DemoUser } from "./api/types";
import { DocumentArchive } from "./components/DocumentArchive";
import { ErrorProvider } from "./error/ErrorContext";
import { ErrorPanel } from "./error/ErrorPanel";
import "./App.css";

const DEMO_USERS: readonly DemoUser[] = ["alice", "bob"];

function App() {
  const [user, setUser] = useState<DemoUser>("alice");

  return (
    <ErrorProvider>
      <header className="app-header">
        <h1>Storix 문서 아카이브 데모</h1>
        <label>
          사용자
          <select
            value={user}
            onChange={(event) => setUser(event.target.value as DemoUser)}
          >
            {DEMO_USERS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
      </header>
      <ErrorPanel />
      <main>
        <DocumentArchive key={user} user={user} />
      </main>
    </ErrorProvider>
  );
}

export default App;
