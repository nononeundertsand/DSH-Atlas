# DSH 0.2.1-rc.2 运行时探针

从仓库根目录执行：

```sh
npm ci --prefix tests/dsh-fixture --ignore-scripts --no-audit --no-fund
node tests/dsh-fixture/session.mjs
```

安装依赖需要网络；运行 `session.mjs` 本身使用模拟模型，不请求真实模型，也不读取真实 profile。它只创建 `os.tmpdir()` 下的专用临时目录，Session persistence 和测试文件都在该目录；测试完成后仅删除自己创建的目录。

此探针加载 DSH rc.2 的真实 Session、Agent Loop、ToolRuntime、JSONL persistence，把测试 Session ID 绑定到临时 AtlasStore 节点，并测试一个测试工具的固定路径允许/拒绝、Agent 释放恢复与重新启动隔离 Context 后恢复。它不是完整 DSH profile；节点到 Session 的产品创建、发送和原生聊天导航还没有接通，也未测试浏览器、真实模型或真实 DSH 内置文件工具。测试用全局 guard 的允许/拒绝结果不证明产品级节点策略、插件卸载后限制、系统隔离或其他工具的安全性。
