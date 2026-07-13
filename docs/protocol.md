# Morz agent-to-agent protocol — v1 (FROZEN)

**Status: FROZEN for 0.0.1 → 0.0.2.** This schema is fixed during 0.0.1 (nothing here is
implemented yet) so every 0.0.1 slice — and every external tool that wants to talk to the
bus later — builds against a stable contract. The bus itself ships in 0.0.2
([roadmap](roadmap/0.0.2.md)).

**Change policy: additive only.**

- New optional fields, new `Part` kinds, new `TaskState` values, new envelope metadata: allowed
  (bump `protocolVersion` minor).
- Renaming, removing, retyping, or changing the meaning of anything below: NOT allowed until a
  v2 with an explicit migration.
- Consumers MUST ignore unknown fields and unknown `Part.kind` / `TaskState` values (forward
  compatibility is the receiver's job).

The shape is A2A-flavored on purpose: **Task → Message → Part → Artifact**. A *Task* is the
unit of work agents hand off; a *Message* is one utterance about a task; a *Part* is one typed
chunk of a message; an *Artifact* is what a task produced.

All identifiers are strings. All timestamps are ISO-8601 UTC with milliseconds
(`2026-07-13T18:04:05.123Z`). All JSON is UTF-8, no BOM.

---

## 1. Identity

```ts
/** Stable identity of one agent lane, e.g. "claude-lane-3", "codex-lane-1", or "morz" (the app itself). */
type AgentId = string

/** ULID/GUID minted by Main. Unique per task board. */
type TaskId = string

/** ULID/GUID minted by the sender. Unique per mailbox. */
type MessageId = string
```

`"morz"` is a reserved `AgentId`: the Main process acting as coordinator (stamping identity,
sweeping leases, surfacing approval dialogs). Agents never mint their own sender identity —
Main stamps `from` on everything that crosses the trust boundary.

---

## 2. Task

The unit of hand-off. Lives on the SQLite task board; mirrored to the file mailbox when a
visible/git-diffable hand-off is wanted.

```ts
type TaskState =
  | 'proposed'  // suggested by an agent or the user; not yet claimable
  | 'accepted'  // approved (auto in Orchestrated; via approval chip in Assisted); claimable
  | 'working'   // claimed by exactly one agent (lease held)
  | 'blocked'   // claimant cannot proceed; blockedReason set; waits for input/deps
  | 'done'      // terminal; artifacts attached

interface Task {
  protocolVersion: '1.0'
  id: TaskId
  state: TaskState
  title: string                 // one-line, human-readable
  /** Who proposed the task. */
  createdBy: AgentId
  /** Who holds it now (state 'working' | 'blocked'), else null. */
  assignee: AgentId | null
  createdAt: string             // ISO-8601 UTC
  updatedAt: string             // ISO-8601 UTC — bumped on every state change
  /** Tasks that must be 'done' before this one is claimable (DAG deps). */
  dependsOn: TaskId[]
  /** Required when state is 'blocked'. */
  blockedReason?: string
  /** Claim lease expiry while 'working' — sweeper re-opens the task past this. */
  leaseUntil?: string
  /** Everything the task produced; appended as work completes. */
  artifacts: Artifact[]
}
```

State machine (legal transitions only — anything else is a protocol error):

```
proposed → accepted            (user approval chip in Assisted; policy in Orchestrated)
proposed → done                (withdrawn/rejected — done with zero artifacts + a text Message)
accepted → working             (CAS claim: exactly one winner)
working  → blocked             (claimant reports blockedReason)
working  → done                (claimant completes; artifacts attached)
blocked  → working             (unblocked: dependency done, or input arrived)
working  → accepted            (lease expired — sweeper reclaims a crashed agent's task)
```

### Example

```json
{
  "protocolVersion": "1.0",
  "id": "01J2Z9GVX0M4Q6R8T0V2X4Z6B8",
  "state": "working",
  "title": "Add retry with backoff to the catalog sync fetcher",
  "createdBy": "claude-lane-1",
  "assignee": "codex-lane-1",
  "createdAt": "2026-07-13T17:55:00.000Z",
  "updatedAt": "2026-07-13T18:04:05.123Z",
  "dependsOn": ["01J2Z9F0AAAABBBBCCCCDDDDEE"],
  "leaseUntil": "2026-07-13T18:19:05.123Z",
  "artifacts": []
}
```

---

## 3. Message

One utterance from one agent about one task. Messages are immutable once written.

```ts
interface Message {
  protocolVersion: '1.0'
  id: MessageId
  /** Stamped by Main — never trusted from the agent. */
  from: AgentId
  /** Target agent, or "morz" for the coordinator. */
  to: AgentId
  /** The task this message is about. Null only for kind-of-broadcast notices (rare). */
  taskId: TaskId | null
  ts: string                    // ISO-8601 UTC, stamped by Main on ingest
  parts: Part[]                 // at least one
}
```

**Trust boundary rule (0.0.2 bus): agent reports arrive as MCP tool results / bus documents —
NEVER as `user`-role messages** injected into another agent's conversation. The receiving
adapter turns a hand-off into a short pointer prompt; the payload stays in the mailbox.

### Example — a hand-off

```json
{
  "protocolVersion": "1.0",
  "id": "01J2Z9H5N0P2R4T6V8X0Z2B4D6",
  "from": "claude-lane-1",
  "to": "codex-lane-1",
  "taskId": "01J2Z9GVX0M4Q6R8T0V2X4Z6B8",
  "ts": "2026-07-13T17:55:01.000Z",
  "parts": [
    { "kind": "text", "text": "Fetcher fails on transient 503s from the registry. Please add retry with jittered backoff; tests in sync.spec.ts cover the happy path only." },
    { "kind": "file", "path": "src/main/catalog/sync.ts", "mtimeMs": 1783100000000 }
  ]
}
```

---

## 4. Part

One typed chunk of a message. Discriminated union on `kind`. Receivers MUST skip unknown kinds.

```ts
type Part = TextPart | FilePart | DiffPart | CommandPart | ApprovalRequestPart

interface TextPart {
  kind: 'text'
  text: string                  // Markdown allowed
}

/** A pointer to a file — never inline content (files stay on disk; mtime detects staleness). */
interface FilePart {
  kind: 'file'
  path: string                  // absolute, or relative to the Space root
  mtimeMs: number               // st_mtimeMs at send time; receiver compares before trusting
  line?: number                 // optional anchor
  col?: number
}

/** A unified diff, self-contained (headers included). */
interface DiffPart {
  kind: 'diff'
  unified: string               // standard `diff -u` / `git diff` text
  baseRef?: string              // commit the diff applies to, when known
}

/** A command an agent ran or proposes to run. argv-form — never a shell string to parse. */
interface CommandPart {
  kind: 'command'
  cwd: string
  argv: string[]                // argv[0] = executable
  exitCode?: number             // present when reporting a finished run
  proposed?: boolean            // true = "I want to run this", not "I ran this"
}

/**
 * A request for human sign-off. In Assisted, EVERY side-effecting hand-off step surfaces one
 * of these as a Morz approval chip before dispatch ("assist, don't take over").
 */
interface ApprovalRequestPart {
  kind: 'approval-request'
  /** What is being approved, human-readable. */
  summary: string
  /** The action to release on approval (typically a command or a task-state change). */
  action:
    | { type: 'run-command'; command: CommandPart }
    | { type: 'dispatch-task'; taskId: TaskId; to: AgentId }
  /** Correlates the eventual allow/deny back to this request. */
  requestId: string
}
```

### Example — approval-gated dispatch (the Assisted chip)

```json
{
  "kind": "approval-request",
  "summary": "Hand task 'Add retry with backoff…' to codex-lane-1",
  "action": { "type": "dispatch-task", "taskId": "01J2Z9GVX0M4Q6R8T0V2X4Z6B8", "to": "codex-lane-1" },
  "requestId": "apr-01J2Z9J0K2M4"
}
```

---

## 5. Artifact

What a task produced. Appended to `Task.artifacts` by the claimant on completion (and
incrementally while `working` when useful).

```ts
interface Artifact {
  /** ULID/GUID, unique within the task. */
  id: string
  producedBy: AgentId
  ts: string                    // ISO-8601 UTC
  /** Human-readable one-liner ("retry logic + 3 tests"). */
  label: string
  /** Files created or modified, as pointers (same rules as FilePart). */
  files: { path: string; mtimeMs: number }[]
  /** Commits produced, when the agent committed. */
  commits: { sha: string; branch: string; message: string }[]
}
```

### Example

```json
{
  "id": "01J2Z9K8Q0S2U4W6Y8A0C2E4G6",
  "producedBy": "codex-lane-1",
  "ts": "2026-07-13T18:20:11.000Z",
  "label": "Jittered-backoff retry + 3 tests",
  "files": [
    { "path": "src/main/catalog/sync.ts", "mtimeMs": 1783100500000 },
    { "path": "src/main/catalog/sync.spec.ts", "mtimeMs": 1783100501000 }
  ],
  "commits": [
    { "sha": "9f2c1ab", "branch": "w4/catalog-retry", "message": "fix(catalog): retry registry fetch with jittered backoff" }
  ]
}
```

---

## 6. Transport contract (mailbox + push)

Two cooperating channels, per [0.0.2 architecture](roadmap/0.0.2.md). The SQLite task board is
the source of truth for task state; the channels below move messages and wake sleepers.

### 6.1 File mailbox — atomic-rename Maildir

Layout, rooted at the Space:

```
.morz/bus/
  <agentId>/
    tmp/    # writes in progress — NEVER read from here
    new/    # delivered, unread
    cur/    # read/processed (receiver moves new/ → cur/)
```

- One file per `Message`, named `<ts-compact>-<messageId>.md`
  (e.g. `20260713T175501000Z-01J2Z9H5N0P2R4T6V8X0Z2B4D6.md`).
- File format: **JSON frontmatter + Markdown body** (Obsidian-flavored so `.morz/bus/` is
  human-browseable and git-diffable). The frontmatter is the `Message` envelope with `parts`
  minus any long `text` part, whose content becomes the Markdown body.
- **Delivery is atomic-rename, always:** write to `tmp/` → `fsync` the file → `rename()` into
  `new/` (same volume, so the rename is atomic). A reader can therefore treat any file in
  `new/` as complete. Writers never write into `new/` directly; readers never read `tmp/`.
- Receiver acknowledges by renaming `new/<file>` → `cur/<file>`. Redelivery = file still in
  `new/` (at-least-once; consumers dedupe on `Message.id`).
- Every mailbox write is mirrored to SQLite by Main (the mailbox is the visible copy, SQLite
  the queryable one).

### 6.2 Push notify — named pipe

Wake-up channel only — **notifications carry no payload**; the receiver reads the mailbox /
task board for content. Losing a notification is safe (poll-on-wake + lease sweeper recover).

- Pipe: `\\.\pipe\morz-bus-<nonce>` — nonce minted per app run; Main is the server.
- Handshake: on connect, the client sends one line `{"type":"hello","token":"<token>"}` and
  Main validates before anything else flows. Nonce + token are handed to each agent process
  privately (env/config at spawn) — this defeats a pipe-squatting process.
- Frames: NDJSON, one JSON object per line:

```json
{ "type": "wake", "to": "codex-lane-1", "reason": "mailbox", "taskId": "01J2Z9GVX0M4Q6R8T0V2X4Z6B8" }
```

```ts
interface WakeFrame {
  type: 'wake'
  to: AgentId
  reason: 'mailbox' | 'task-state' | 'sweeper'
  taskId?: TaskId
}
```

### 6.3 Ordering + delivery guarantees

- **At-least-once** message delivery (Maildir); consumers MUST dedupe on `Message.id`.
- Per-sender mailbox order is filename order (timestamp prefix); no global cross-agent order
  is guaranteed.
- Task-state transitions are serialized by the SQLite board (CAS claim:
  `UPDATE … WHERE status='ready' RETURNING …` — exactly one claimant wins).
- Mode gating is OUTSIDE this schema: in Manual the bus does not run at all; in Assisted every
  dispatch is preceded by an `approval-request`. The protocol does not change per mode — only
  whether/when Main forwards.

---

## 7. Version history

| protocolVersion | Date       | Change                          |
|-----------------|------------|---------------------------------|
| 1.0             | 2026-07-13 | Initial freeze (0.0.1, Slice 6) |
