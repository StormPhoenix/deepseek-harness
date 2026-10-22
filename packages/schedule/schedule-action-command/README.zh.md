---
description: "按绑定 Session 策略执行 shell 命令的 Schedule 动作提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-action-command

[English](README.md) | 中文

## 概述

无需模型轮次即可直接执行定时 shell 命令，使用绑定 Session 的沙箱策略，以及 Schedule 任务保存的目录和截止时间。

## 目录

- [用法](#usage)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="usage"></a>
## 用法

与 Host `schedule` 服务和 shell 执行器一起挂载。插件通过 `ctx.schedule.actions` 注册 `command` 动作，不创建任务，也不调用模型。任务创建和审批由 Schedule 工具消费者负责。

规格必须是 `{ command: string }`，命令不能为空。保留原始引用和空白。每次运行把创建时保存的工作目录、经过时间截止、取消信号和解析后的 Session 沙箱策略交给 `ctx.shell.resolve()` 和 `execute()`。不额外注入环境变量或受管的 `DSH_*` 条目。策略不是 `danger-full-access` 时，拒绝使用不支持约束的执行器。

结果合并 stdout 和 stderr，保留退出码与输出截断信息，区分成功、失败、超时、取消和沙箱拒绝。卸载时注销提供方，取消活动命令，并等待执行结果。

时间和结果回报规则见 [Schedule 子系统](../../../docs/subsystems/schedule.zh.md)。

<a id="dev-note"></a>
### 开发备注

提供方卸载必须先注销，再取消活动执行；已经移除的注册引用不得启动命令。单元测试与 Loader 组合测试固定这两项行为。

<a id="model-experience"></a>
## 模型体验

### 动作选择

#### 模型看到什么

Schedule 工具消费者公开此提供方时，规格只有一个必填的 `command` 字符串。提供方描述为：

##### 提供方描述

```markdown
Run a shell command in the saved working directory under the Session sandbox policy. No model is called.
```

#### Token 影响

有条件：只有 Schedule 工具消费者公开命令动作时，提供方描述和命令规格才贡献 token。本插件不发起模型请求。

#### KV Cache 影响

挂载期间描述和 schema 保持稳定。增加或移除此提供方会改变消费者的工具 schema，可能从 schema 变化处开始使缓存复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- shell 语法取决于挂载的执行器；更换提供方或平台后不会把 Bash 命令翻译成 PowerShell 命令。
- 任务不能单独提供环境变量。命令继承执行器清理凭据后的默认环境；敏感输出仍可能进入运行记录，并按回报策略进入 Session 日志。
