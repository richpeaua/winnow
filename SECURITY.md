# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's [**Report a vulnerability**](https://github.com/richpeaua/winnow/security/advisories/new) (Security → Advisories), or open a minimal private channel with the maintainer. Include:

- a description of the issue and its impact,
- steps to reproduce (a minimal repro is ideal),
- affected version / commit.

You can expect an initial acknowledgement within a few days. Please allow a reasonable window to address the issue before any public disclosure.

## Scope notes

Winnow executes agent-provided code in a **sandbox** (`run_code`): synchronous QuickJS-WASM inside a `worker_thread`, capability-injected (no ambient `fs`/`net`/`env`/`process`), with wall-clock and memory limits and an output cap. Sandbox-escape reports are especially in scope.

Winnow also brokers connections to upstream MCP servers and injects credentials from environment variables. Reports involving credential handling, the gateway auth path, or result-filter bypass are in scope.

Supported version: the latest `master` / most recent release.
