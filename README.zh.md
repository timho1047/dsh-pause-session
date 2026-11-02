# dsh-pause

[English](README.md) | 中文

在离开前把每个运行中的 DSH 会话及其子代理停在安全点，第二天再恢复，就像从未中断。

要求 DSH `>=0.2.2-alpha.2 <0.3.0-0`；包通过 `engines.dsh` 声明该范围，因此插件管理器会拒绝旧版本运行时，而不是启动不兼容的恢复路径。

**状态：功能完成，等待完整端到端演练。** 按一次会把每个运行中的会话树停在模型的下一条请求边界，并报告所有会话是否都已暂停；暂停状态可跨进程重启；下一次按下会用会话原来的 Agent preset 组合（恢复作用域工具、prompt section 和子代理委派上下文）恢复干净暂停的会话，不向请求中额外添加内容；没有完全暂停的会话会进入决策清单。真实机器上尚未验证的部分见 [REHEARSAL.md](REHEARSAL.md)。

## 安装

通过 Web 侧边栏的 **Plugins** 页面安装 bundle，或在目标 profile 的会话里使用 `plugin_manager`（`install_bundle`，`target` 指向本目录的绝对路径）。安装会添加包、选中 bundle 并激活。

## 卸载

在同一个 Plugins 页面移除 bundle，或使用 `plugin_manager`（`remove_bundle`，`target` = `dsh-pause`）。会话头部不再显示该控件，profile 的其他部分不变。

## 开发

```sh
pnpm install
pnpm run verify     # typecheck + build + tests
pnpm run build      # tsc（两个面）然后由 tsdown 打包 lib/index.js 和 lib/client.js
```

宿主半边构建为 `lib/index.js`，由 Loader 加载；浏览器半边构建为 `lib/client.js`，即浏览器按 id `dsh-pause` 加载的 `window.__ModuleLoader__` bundle。`tsdown.client.ts` 是本目录插件共用的 vendored client-bundle preset。

这是个人插件仓库，`dsh-plugins/` 不属于 DSH 官方源码树。开发依赖通过相对链接指向 `../../deepseek-harness` 的 DeepSeek Harness checkout，因此本地 typecheck、build 和 test 需要在相同的相对深度存在该 checkout。npm 上已发布的包版本低于本插件使用的 `0.2.2-alpha.2` API，所以新 clone 可以执行 `pnpm pack`，但在匹配版本的包发布前无法运行完整验证。

## 设计记录

规格与任务拆分在 `.scratch/pause/`，按本目录约定只保留在本地。

设计中真正承重的发现——安全点到底在哪、一次暂停会给周围应用带来什么成本、重启会把一个已暂停的会话变成什么——记录在 spec 的 evidence 部分。改动暂停或恢复路径前先读它。

[REHEARSAL.md](REHEARSAL.md) 是端到端验收流程：自动化套件已经证明了什么、如何安装、手动步骤，以及 profile 起不来时如何回滚。
