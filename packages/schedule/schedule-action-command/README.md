---
description: "Schedule action provider for shell commands under the bound Session policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-action-command

English | [中文](README.zh.md)

## Summary

Run scheduled shell commands directly without a model turn, using the bound Session's sandbox policy and the Schedule task's captured directory and deadline.

## Table of Contents

- [Usage](#usage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Usage

Mount beside the Host `schedule` service and a shell executor. The plugin registers the `command` action through `ctx.schedule.actions`; it does not create tasks or call a model. Task creation and approval belong to the Schedule tool consumer.

The specification is exactly `{ command: string }`, with a non-empty command. Quoting and whitespace are preserved. Each run passes its captured working directory, elapsed deadline, cancellation signal, and resolved Session sandbox policy to `ctx.shell.resolve()` and `execute()`. No extra environment or managed `DSH_*` entries are injected. A non-confining executor is refused unless the policy is `danger-full-access`.

The result combines stdout and stderr, preserves the exit code and capture truncation, and distinguishes success, failure, timeout, abort, and sandbox denial. Unloading removes the provider registration, cancels active commands, and waits for their execution results.

See the [Schedule subsystem](../../../docs/subsystems/schedule.md) for timing and result reporting.

### Dev Note

Provider teardown must unregister before cancelling active executions, and calls through a removed registration must not start a command. Unit tests and the Loader composition test pin both behaviors.

## Model Experience

### Action selection

#### What the model sees

When the Schedule tool consumer exposes this provider, its specification has one required `command` string. The provider description is:

##### Provider description

```markdown
Run a shell command in the saved working directory under the Session sandbox policy. No model is called.
```

#### Token effect

Conditional: the provider description and command specification contribute only when the Schedule tool consumer exposes command actions. This plugin itself makes no model request.

#### KV Cache effect

The description and schema remain stable while mounted. Adding or removing this provider changes the consumer's tool schema and can invalidate reuse from that schema change onward.

## Known Limitations and Deferred Work

- Shell syntax follows the mounted executor; Bash commands are not translated into PowerShell commands after a provider or platform change.
- Tasks cannot supply separate environment variables. Commands inherit the executor's credential-scrubbed default environment; sensitive output can still enter saved run records and, according to the task report policy, the Session log.
