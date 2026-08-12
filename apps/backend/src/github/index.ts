/**
 * `github/` — repository discovery and commit/PR polling producers (TDS 02 §2).
 *
 * SCAFFOLD STATE: directory placeholder. Nothing here is implemented.
 *
 * What lands here (owner: WS1, contract: TDS 04 §5):
 *   - repository discovery by scanning the repo roots configured in Settings; paths are
 *     absolute native paths validated by Test Connection (F8.1 path rules)
 *   - commit and pull-request polling; results are written to `commits` / `pull_requests`
 *     and emit `repository.synced`, `commit.recorded`, `pull_request.*` (TDS 04 §15.2)
 *   - GitHub REST access via octokit; local git invoked through `execFile` with an
 *     explicit executable path — never a shell-out to a platform-specific command (F8.1)
 *   - token read through the settings/secret layer, never from the environment (F8.2)
 *
 * Phase note: the Backend is the producer in Phase 1 (on demand + in-process interval);
 * scheduled polling moves to the Sync Worker in Phase 2 with identical event names and
 * payloads — only the envelope `source` differs (TDS 04 §15.2).
 */
export {};
