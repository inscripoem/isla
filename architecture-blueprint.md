# Isla foundation blueprint

Status: under review. Scope: initial runnable foundation, 2026-10-09.

Isla will be a reusable AI VTuber runtime plus local console. The chosen direction is TypeScript/Node.js, React/Vite, pnpm, SQLite persistence, validated JSON WebSocket traffic and independent synthesis/player/renderer adapters. The foundation implements local diagnostics only; it does not implement those future product capabilities.

Use one package. M2 owns src/console, M5 owns src/runtime and shared boundary coordination in src/contracts. Future M1 performance adapters, M3 decision providers, M4 dialogue/memory and M6 storage/evaluation remain separate responsibilities, without empty implementations now.

The current boundary is loopback-only HTTP health and validated JSON WebSocket diagnostics. It rejects unsupported product actions and malformed messages; diagnostics do not imply successful chat, playback or persistence. Diagnostic version 1 is distinct from the planned application protocol 0.2. Shutdown releases sockets and reports failures explicitly. Logs contain operation/outcome metadata without raw credentials.

Future runtime authority remains deterministic: AI proposes but cannot bypass authorization, Stop or stale-result rejection. Completed audio evidence will govern spoken memory. SQLite will own persistent records; the coordinator will own live state. These are future requirements, not scaffold claims.

The approved scaffold/test plan is recorded in the actual OpenCode sessions. Initial CI covers types, lint, offline boundary tests and builds. Full semantic evaluation, test-approval automation, requirements validation and remote branch protection must be developed and verified in later increments. Keep documentation concise and preserve genuine evidence outside the repository until a reviewed submission/export step.
