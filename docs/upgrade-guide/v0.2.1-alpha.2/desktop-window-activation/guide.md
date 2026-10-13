---
kind: upgrade-guide
description: "Windows plugins requesting Desktop activation must use the Desktop PID and wait for confirmed window state instead of an action acknowledgement."
---

# Windows Desktop activation requires coordinated upgrades

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.2, Desktop advertises `DSH_DESKTOP_WINDOW_ACTIVATION=1` without its PID, and activation success acknowledges the shell action rather than confirmed focus. Updated external Windows plugins, including locally installed pet plugins, require `DSH_DESKTOP_WINDOW_ACTIVATION_PID`; updating only the plugin leaves activation unavailable with an older Desktop.

Desktop now supplies its own positive uint32 PID. The helper that receives user input must call `AllowSetForegroundWindow` for that exact PID before the Host sends `{ type: 'activate-window', requestId }`. Desktop asynchronously replies with `{ type: 'window-activated', requestId, error?, errorCode? }`. Success confirms a visible, nonminimized, focused window within 1000 ms, including window preparation; mandatory-update and Welcome windows retain priority. Activation does not retry or change topmost state. Failures report `unavailable`, `activation-timeout`, or `focus-denied` rather than success.

## Migration

1. Upgrade Desktop and the external plugin together, then fully quit and restart Desktop so the Host and helper receive the new environment and code. For source deployments, fully rebuild Desktop and the plugin before restarting; a renderer reload is insufficient. Do not manually set or guess `DSH_DESKTOP_WINDOW_ACTIVATION_PID`.
2. If you maintain an activation plugin, require both environment variables and validate the PID as a positive uint32. Grant foreground permission only to that PID from the input-owning helper before sending the request; use a positive safe-integer `requestId`. Await the asynchronous reply and handle `error` and `errorCode` without automatic retries or topmost changes. The [Desktop README](../../../../apps/desktop/README.md) owns the activation details.
3. On Windows, hide or minimize Desktop, then use the plugin's activation gesture. Confirm that the selected window becomes visible, restored, and focused, or that the plugin reports an activation failure. Check mandatory-update and Welcome priority when applicable. Real native behavior across the supported Windows matrix still requires release-owner verification; documentation checks do not establish that result.
