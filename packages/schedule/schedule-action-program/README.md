---
description: "Schedule action provider for isolated programs without model or tool bindings."
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-action-program

English | [中文](README.zh.md)

## Summary

Run scheduled programs in the configured isolated runtime without calling a model or exposing tools, while retaining the Session policy and execution results.

## Table of Contents

- [Usage](#usage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Usage

Mount beside the Host `schedule` service and a `ptcRuntime` provider with function-body evaluation. Persistent REPL evaluation is refused at activation. The plugin registers `program` on `ctx.schedule.actions`; it does not create tasks or call a model.

Input contains a non-empty `source`. The stored specification also records the runtime's `language`; a later runtime with a different language produces an unavailable outcome rather than executing the program. Source text is preserved. The shipped Node runtime accepts an async TypeScript function body with top-level `await` and `return`; use `await import(...)` for Node APIs.

Each run passes the captured working directory, elapsed deadline, cancellation signal, and resolved Session sandbox policy to `ctx.ptcRuntime`. Bindings are empty and no state owner is supplied: there is no `callLLM`, tool binding, or retained program state. A runtime without sandbox-policy support is refused. Logs, JSON completion, and failure diagnostics become the saved output. Unloading unregisters the provider, cancels active programs, and waits for their results.

See the [Schedule subsystem](../../../docs/subsystems/schedule.md) and [PTC runtime](../../../docs/subsystems/ptc-runtime.md).

### Dev Note

Keep each run independent: no retained state owner or host bindings. Reject a changed runtime language and a removed provider before execution; the provider and Loader composition tests pin these contracts.

## Model Experience

### Action selection

#### What the model sees

When the Schedule tool consumer exposes this provider, its specification has one required `source` string. The description combines the mounted runtime's `executionInstructions` with the suffix `No host functions, tools, or callLLM are provided.`

#### Token effect

Conditional: runtime-owned usage instructions and the source specification contribute when the Schedule tool consumer exposes program actions. Executing this action does not make a model request.

#### KV Cache effect

The description remains stable for a fixed runtime. Changing its instructions or adding/removing the provider changes the consumer's tool schema and can invalidate reuse from that change onward.

## Known Limitations and Deferred Work

- Stored source is language-specific and is not translated when the runtime language changes.
- No `callLLM`, task helper API, or persistent REPL is provided. Output can contain sensitive data and enter both saved run records and the Session log according to the report policy.
