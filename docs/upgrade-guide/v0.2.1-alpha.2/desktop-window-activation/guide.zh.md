---
kind: upgrade-guide
description: "请求激活 Desktop 的 Windows 插件必须使用 Desktop PID，并等待窗口状态确认，不再只接受操作应答。"
---

# Windows Desktop 激活需要协同升级

[English](guide.md) | 中文

## 变更

v0.2.1-alpha.2 的 Desktop 仅通过 `DSH_DESKTOP_WINDOW_ACTIVATION=1` 声明能力，不提供自身 PID；激活成功仅确认壳已执行操作，不确认焦点。更新后的 Windows 外部插件（包括本地安装的桌宠插件）依赖 `DSH_DESKTOP_WINDOW_ACTIVATION_PID`；仅升级插件而保留旧 Desktop 时，激活不可用。

Desktop 现在提供自身的正 uint32 PID。接收用户输入的 helper 必须在 Host 发送 `{ type: 'activate-window', requestId }` 前，调用 `AllowSetForegroundWindow` 只向该精确 PID 授予前台权限。Desktop 异步返回 `{ type: 'window-activated', requestId, error?, errorCode? }`。成功表示在包含窗口准备的 1000 ms 时限内，已确认窗口可见、未最小化且获得焦点；强制更新和 Welcome 窗口保留优先级。激活不重试，也不改变置顶状态。失败返回 `unavailable`、`activation-timeout` 或 `focus-denied`，不会作为成功处理。

## 迁移

1. 协同升级 Desktop 与外部插件，然后完全退出并重启 Desktop，让 Host 和 helper 接收新的环境与代码。从源码部署时，先完整重新构建 Desktop 与插件，再重启；仅重载渲染页面不生效。不要手动设置或猜测 `DSH_DESKTOP_WINDOW_ACTIVATION_PID`。
2. 如果你维护激活插件，要求两个环境变量均存在，并校验 PID 为正 uint32。接收用户输入的 helper 必须在发送请求前只向该 PID 授予前台权限；`requestId` 使用正安全整数。等待异步应答并处理 `error` 与 `errorCode`，不自动重试，也不改变置顶状态。激活详情由 [Desktop README](../../../../apps/desktop/README.zh.md)维护。
3. 在 Windows 上隐藏或最小化 Desktop，再使用插件的激活手势。确认选定窗口变为可见、恢复且获得焦点，或插件报告激活失败。适用时检查强制更新与 Welcome 的优先级。受支持 Windows 矩阵的真实原生行为仍需发布负责人验证；文档检查不能证明该结果。
