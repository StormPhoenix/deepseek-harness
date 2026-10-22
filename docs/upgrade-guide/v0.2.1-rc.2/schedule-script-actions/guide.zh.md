---
kind: upgrade-guide
description: "Schedule 脚本任务扩展持久任务行与立即运行响应。"
---

# Schedule 脚本任务

[English](guide.md) | 中文

## 变更

Schedule 在提醒之外支持程序脚本与命令动作。已有提醒数据仍可读取。创建脚本任务后，宿主会向 Schedule 存储写入动作、绑定、回报策略与运行记录等新字段；旧版 DSH 拒绝这些字段，因此不支持将包含脚本任务的存储降级。

提醒任务的 `schedule.run()` 仍返回投递确认。脚本任务则通过 `ran: true`、`runId` 和 `startedAt` 确认已接纳运行，不代表执行完成。上一次仍在运行时再次手动触发，返回 `schedule_running`。通过 `schedule.runs()` 读取执行结果。

## 迁移

1. 升级前备份配置的 Schedule 存储。创建脚本任务后，不要用旧版 DSH 打开升级后的存储；需要回退时恢复升级前备份。
2. 使用脚本任务的自定义 profile 将 `@deepseek-ai/dsh-schedule-action-command` 与 shell 执行器一起挂载，或将 `@deepseek-ai/dsh-schedule-action-program` 与函数体程序运行时一起挂载。随附 Web 组合已挂载两者。已有提醒 profile 不需要动作提供方。
3. 更新 `schedule.run()` 的自定义消费者，区分 `deliveredAt` 与 `runId`/`startedAt`。通过 `schedule.runs({ sessionId, id, limit })` 获取脚本结果，不将运行接纳视为完成。
4. 确认已有提醒仍可见，脚本任务的执行记录展示运行结果。脚本保留原 Session 绑定与创建时的沙箱权限上限。
