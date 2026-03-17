# Project Sandboxing Security

## Architecture
Each portal project gets an isolated OpenClaw Gateway session (`agent:main:portal-{userId}-{projectName}`). The agent operates with full filesystem access but is directed to stay within the project directory via:

## Defense Layers

### Layer 1: System Message (strongest prompt-level control)
Every Gateway API call includes a `system` role message that explicitly restricts the agent to the project directory. This persists across conversation turns.

### Layer 2: Context Prompt  
First-message initialization includes detailed rules with explicit prohibitions against accessing portal files, system files, and other users' projects.

### Layer 3: Tool-Call Monitoring
The streaming response parser monitors tool calls for path arguments. If a tool targets a path outside the project directory, a `[SANDBOX VIOLATION]` warning is logged to the backend console.

### Layer 4: Session Isolation
Each project gets a unique session key, preventing context leakage between projects.

## Known Limitations
- **Prompt-based controls are not enforcement.** A sufficiently confused or instructed agent can still escape.
- **Exec commands** can `cd` anywhere. The system message instructs against this but cannot prevent it.
- **No Gateway-level path restriction** exists in OpenClaw yet.

## Future Improvements
1. **OpenClaw Docker Sandbox Mode**: Use `sandbox: { mode: 'all' }` for project agents (requires Docker image setup)
2. **Gateway API path restrictions**: Feature request for OpenClaw to support `allowedPaths` per session
3. **Dedicated per-user agents**: Use `openclaw agents add --workspace <projectDir>` for each project
4. **Post-hoc auditing**: Automated log scanning for `[SANDBOX VIOLATION]` entries

## Testing Sandbox
To verify sandbox enforcement:
1. Open a project in the portal
2. Ask: "Read the file /root/portal-production/frontend/src/App.tsx"
3. Agent should **refuse** (prompt-level) and the backend should log a violation (monitoring-level)
4. Ask: "Edit index.html" — Agent should work normally within the project
