---
description: "执行隔离程序且不绑定模型或工具的 Schedule 动作提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-action-program

[English](README.md) | 中文

## 概述

在配置的隔离运行时中执行定时程序，不调用模型或暴露工具，并保留 Session 策略与执行结果。

## 目录

- [用法](#usage)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="usage"></a>
## 用法

与 Host `schedule` 服务和函数体求值的 `ptcRuntime` 提供方一起挂载。激活时拒绝持久 REPL 求值。插件在 `ctx.schedule.actions` 注册 `program`，不创建任务，也不调用模型。

输入包含非空 `source`。持久规格还记录运行时的 `language`；后续运行时语言不同时返回不可用结果，不执行程序。源码原样保留。随附的 Node 运行时接受异步 TypeScript 函数体，支持顶层 `await` 和 `return`；通过 `await import(...)` 使用 Node API。

每次运行把创建时保存的工作目录、经过时间截止、取消信号和解析后的 Session 沙箱策略交给 `ctx.ptcRuntime`。绑定为空且不提供状态所有者：没有 `callLLM`、工具绑定或保留的程序状态。拒绝不支持沙箱策略的运行时。日志、JSON 返回值和失败诊断组成保存的输出。卸载时注销提供方，取消活动程序，并等待结果。

参见 [Schedule 子系统](../../../docs/subsystems/schedule.zh.md) 和 [PTC 运行时](../../../docs/subsystems/ptc-runtime.zh.md)。

<a id="dev-note"></a>
### 开发备注

保持每次运行独立，不保留状态所有者或宿主绑定。执行前拒绝运行时语言变化和已注销提供方；提供方与 Loader 组合测试固定这些契约。

<a id="model-experience"></a>
## 模型体验

### 动作选择

#### 模型看到什么

Schedule 工具消费者公开此提供方时，规格只有一个必填的 `source` 字符串。描述由挂载运行时的 `executionInstructions` 和后缀 `No host functions, tools, or callLLM are provided.` 组成。

#### Token 影响

有条件：Schedule 工具消费者公开程序动作时，运行时使用说明和源码规格贡献 token。执行该动作不发起模型请求。

#### KV Cache 影响

运行时不变时描述保持稳定。改变运行时使用说明，或增加、移除提供方会改变消费者的工具 schema，可能从变化处开始使缓存复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 保存的源码与语言绑定，更换运行时语言时不会翻译源码。
- 不提供 `callLLM`、任务辅助 API 或持久 REPL。输出可能包含敏感数据，并按回报策略进入运行记录与 Session 日志。
