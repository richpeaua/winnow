# Wayfinder tracker (local-markdown)

No external issue tracker was provided, so this map uses the **local-markdown** default.

## Layout
- `map.md` — the map (label `wayfinder:map`). Index only; decisions live in their tickets.
- `tickets/NN-slug.md` — child tickets of the map. Filename order ≈ creation order.

## Ticket frontmatter
```yaml
id:         short stable code (e.g. C1)
title:      human name — always refer to tickets by this, never the id alone
type:       research | prototype | grilling | task
labels:     [wayfinder:ticket, wayfinder:<type>]
status:     open | closed
assignee:   empty = unclaimed. Claiming = set this BEFORE any work.
blocked_by: [ids]  — ticket is unblocked when every id here is closed
map:        map.md
```

## Wayfinding operations (this tracker)
- **Frontier** = open tickets whose `blocked_by` are all `status: closed`, and `assignee` empty.
- **Claim** = set `assignee` on the ticket file, first thing.
- **Resolve** = append a `## Resolution` section to the ticket body, set `status: closed`, then add a one-line pointer to `map.md` → Decisions so far.
- **Block** = list blocker ids in `blocked_by`.
- **Out of scope** = set `status: closed` + one line in map's Out-of-scope; never graduates.
- Assets created while resolving link from the ticket, not pasted in.
