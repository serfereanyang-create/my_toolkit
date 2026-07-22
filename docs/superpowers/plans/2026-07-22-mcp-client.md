# MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship stdio MCP client that loads `.aicode/mcp.json`, bridges tools into the registry under approval policy, and exposes `/mcp`.

**Architecture:** Config → spawn stdio JSON-RPC (Content-Length) → tools/list → `mcp_<server>_<tool>` bridge → ToolRegistry + hooks. Failures isolated per server.

**Tech Stack:** TypeScript NodeNext, node:child_process, node:test, no new npm deps.

## Tasks

- [x] Framing + config + types
- [x] Client connect/list/call/close
- [x] Bridge + manager + fixture server
- [x] Wire index/doctor/commands/agent runtime
- [x] Tests + audit + docs + matrix
