---
id: C1
title: Design the progressive-disclosure tool catalog & schema-loading model
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
blocked_by: [R1]
map: map.md
---
## Question

How does the SDK expose N servers' tools without loading every schema upfront? Decide the def-bloat core:
- What lives in the always-present catalog entry per tool (name + one-line? + server), and what is withheld until loaded (full `inputSchema`, long description, examples).
- The disclosure lifecycle: `search → load schema(s) → call`. When are upstream servers actually connected — eager at init vs lazy on first touch?
- How the catalog is built and kept fresh (list-changed notifications, pagination), and whether it persists across process restarts.
- Token budget: rough target for catalog-entry size and how many tools stay "cheap" at rest.

Output: the catalog data model + disclosure state machine, precise enough to build.
