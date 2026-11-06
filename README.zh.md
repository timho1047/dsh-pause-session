# dsh-pause-session

[English](README.md) | 中文

<p align="center"><img src="icon.svg" width="64" height="64" alt="dsh-pause-session 图标"></p>

[npm: dsh-pause-session](https://www.npmjs.com/package/dsh-pause-session)

在离开前暂停所有运行中的 DSH 会话及其子代理，之后再恢复。

dsh-pause-session 会把每个会话停在同一个点：当前已经运行的工具先跑完，然后拦住下一条模型请求。子代理树也会一起暂停，暂停状态可以跨 DSH 重启保留。

> 状态：beta。已针对 DSH `0.2.2-alpha.2` 验证；完整的实机演练见 [REHEARSAL.md](REHEARSAL.md)。

<p align="center">
  <img src="docs/images/pause-controls.webp" alt="dsh-pause-session 控件：会话已暂停，全局显示全部已暂停" width="100%">
</p>

*会话已暂停；全局控件显示“全部已暂停”（1/1）。*

## 快速开始

1. 按目标选择安装方式：

   **Desktop**：打开 Desktop 侧边栏的 **Plugins** 页面，在那里安装
   `dsh-pause-session`。

   **Web profile，从 npm 安装：**

   ```sh
   dsh plugin --profile web add dsh-pause-session
   ```

   **Web profile，从源码安装：**

   ```sh
   git clone https://github.com/timho1047/dsh-pause-session.git
   dsh plugin --profile web add "$PWD/dsh-pause-session"
   ```

   两种 Web 安装方式完成后，都重启一次 DSH Web 进程，让运行中的进程加载
   新的 client bundle。仓库里已经提交了构建好的 `lib/`，不需要额外构建；
   只有改过源码时才需要重新构建。本地开发布局见
   [DEVELOPMENT.md](DEVELOPMENT.md)。
2. 打开要暂停的会话。按标题旁的暂停按钮，会暂停这个会话及其子代理；按头部右侧的胶囊，会暂停所有运行中的会话树。
3. 控件会先显示 **正在暂停**（Pausing），等运行中的工具结束、下一条模型请求被拦住后，才会变成 **已暂停**（Paused）。全局胶囊变成 **全部已暂停**（All Paused）时，所有已登记的会话都已停住。
4. 下次按 **全部已暂停** 可以恢复所有干净暂停的会话；按会话旁的控制可以只恢复这一个会话及其子代理。

## 两个控件

| 控件 | 范围 | 作用 |
|---|---|---|
| 会话标题旁 | 一个会话及其子代理 | 暂停当前会话树，之后恢复同一个会话树。 |
| 头部右侧胶囊 | 所有运行中的会话树 | 暂停所有已登记会话，之后恢复所有干净暂停的会话。 |

有工具在运行时，会话显示 **正在暂停**。只有工具返回、下一条模型请求被拦住并且会话状态已保存后，才会进入 **已暂停**。

## 暂停具体做了什么

- 已经在运行的工具会先跑完；暂停生效后不会再发新的工具调用或模型请求。
- 下一条模型请求会在到达供应商之前被拦住。
- 已经登记在暂停树里的子代理会按同样规则停下。
- 暂停状态是持久化的。DSH 退出或重启后，下次挂载会重新拦住这些会话。
- 输入框保持可用；暂停要通过同一个控件释放，而不是靠再发一条消息。
- 在 Web 宿主上，两个控件通过同源状态路由刷新；后台读取不会向会话追加命令记录。斜杠命令仍用于用户主动操作，以及没有该路由的载体上的回退。

## 哪些东西不会被停住

- agent loop 之外的后台任务和 shell 任务不会被停住；全局控件会把它们列为限制。
- Codex、Claude Code、ACP、DSH SDK 等外部一次性子代理不能继续下一轮，也不能冷恢复。它们会被报告为不可恢复，不会登记成本地暂停会话。
- 暂停中的会话在 DSH 的部分生命周期里仍显示为 `running`。退出 DSH 可能需要约 5 秒；归档、上下文压缩和 `wait_agent` 在会话被拦住时的行为可能不同。

## 恢复与目标

干净暂停的会话会从停下的位置恢复。会话目标默认会在恢复时重新打开，这意味着它可以自己继续跑轮次并产生消耗。离开前如果不想这样，可以在会话控件上关掉目标开关。这个设置会写进暂停记录，在该会话恢复时生效。

没有干净暂停的会话不会被静默恢复。全局控件会打开决策清单，每一行可以继续、带说明继续（说明工具结果未知）、只看不运行，或保持暂停。

## 命令

按钮驱动的就是这些命令；脚本和键盘操作用得上：

| 命令 | 作用 |
|---|---|
| `/pause` | 暂停当前会话及其子代理。 |
| `/pause-resume` | 恢复当前暂停的会话树。 |
| `/pause-resume-all` | 恢复所有干净暂停的会话。 |
| `/pause-all` | 暂停所有运行中的会话树。 |
| `/pause-state` | 读取当前会话树的暂停状态。 |
| `/pause-state-all` | 读取整体暂停状态。 |
| `/pause-goal` | 切换当前会话恢复时是否重新打开目标。 |
| `/pause-triage` | 读取未干净暂停会话的决策清单。 |
| `/pause-triage-continue`、`note`、`review`、`leave`、`goal` | 对清单中的一个会话执行对应决策。 |

状态读取本身也是命令，所以会在会话转录里留下命令行。

## 要求

- DSH `>=0.2.2-alpha.2 <0.3.0-0`。包通过 `engines.dsh` 声明该范围；插件管理器会拒绝旧版本运行时，而不是启动不兼容的恢复路径。
- 标准 Web profile。它会挂载 `sessionQuery` 和 `agentPresets`，恢复路径用它们重建每个会话原本的 Agent 组合。
- 如果从本仓库构建，还需要满足 [DEVELOPMENT.md](DEVELOPMENT.md) 里的本地开发布局。

插件不发起网络请求。暂停记录保存在 profile 的存储中，会话状态仍保存在原有会话日志里。

## 开发

工作区布局、构建命令、测试和本地 DeepSeek Harness 依赖链接见 [DEVELOPMENT.md](DEVELOPMENT.md)。完整的人工验收流程见 [REHEARSAL.md](REHEARSAL.md)。

## 更新记录

发布记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
