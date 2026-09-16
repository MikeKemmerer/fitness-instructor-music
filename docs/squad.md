# Squad

Internal codenames inspired by fitness instructors, not impersonation or endorsement.

| Codename | Role | Files |
| --- | --- | --- |
| Horton | Lead/integrator | Root, shared contracts, docs, agents, integration tests |
| Simmons | Audio/offline | Player, IndexedDB, worker/service worker, audio tests |
| Fonda | UI/editor | Remaining frontend source, appearance, English catalog, UI tests |
| Pilates | Backend/security | api/, security tests |
| Wicks | Azure/releases | infra/, .github/workflows/ |
| Michaels | Independent review | Read-only findings, no edits |

Six total; no more than three writers concurrently. One audio-clock owner. No overlapping files or independent Git/cloud actions. Contracts stable per task; changes reconciled by Horton before dependent edits. Focused validation immediately after substantive edits. Delegates report actual tests and limitations. Lead independently checks integrated behavior.

Current run used the Simmons, Fonda and Pilates role instructions in bounded delegated sessions and a Michaels-style independent review. Agent files under .github/agents are available for subsequent editor discovery; tool registration may require an editor refresh. No claim of continuously running background agents.