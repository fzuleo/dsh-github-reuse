---
name: oss-reuse
description: 在用成熟开源项目拼装功能时使用：检索 GitHub、体检候选、确认依赖与真实 API，然后优先装包集成而不是从零实现。
---

# oss-reuse：用成熟开源项目拼装功能

## 硬性门槛（先做这一步）

动手写任何自研代码前，必须先给出**至少 2 个开源候选**（仓库名 + star + 许可证 + 最近更新），或明确写"已检索但无可用实现"并附上检索关键词。跳过这一步就等于违规。

## 何时用

用户提出一个功能需求，而这块能力很可能已有成熟实现（登录鉴权、图表、PDF 导出、解析器、调度器、状态机、编辑器、爬虫、CLI 框架、序列化、模糊测试等）。目标是**少写代码、拿现成能力**，而不是炫技手写。

## 四个工具

- `github_search`：检索仓库。参数：`query`（必填，GitHub 搜索语法）、`minStars`、`language`、`license`、`pushedWithinDays`、`topic`、`sort`（best-match / stars / updated）、`maxResults`。
- `github_inspect`：仓库体检，返回 star、fork、issue 数、语言、最近推送、体积、归档状态、许可证、最新 release、依赖概况、README 摘要、体检结论。
- `github_tree_and_manifest`：在线读取根目录清单（package.json / pyproject.toml / requirements.txt / Cargo.toml / go.mod / composer.json / pubspec.yaml / Gemfile），给出依赖数与装包命令，估算集成成本。可用 `paths` 指定 monorepo 子目录。
- `github_read`：读仓库内任意文件（走 raw 通道，不受 API 配额限制），用于确认导出 API、示例代码、许可证文本。

## 标准流程

1. **需求拆解**：把需求拆成"能力块"，例如「导出 Excel」= 表格写入 + 样式 + 公式。每块单独找库。
2. **分区检索**：每块用 2–3 个不同说法搜索（`xlsx writer`、`spreadsheet export`、`excel stylesheet`），中文需求再补一次中文关键词。
3. **体检对比**：对每个候选跑 `github_inspect`，把结果整理成表。
4. **确认 API**：跑 `github_read` 读 README 的 Usage 段与 `types` / `index.d.ts`，确认函数签名确实存在。
5. **试集成**：按装包命令安装最小依赖集，写一个最小可运行示例先跑通，再扩到完整需求。
6. **记录决策**：在回答里写出选型理由、被否掉的候选与否掉原因、许可证与维护风险。

## 选型硬门槛

- 许可证：MIT / Apache-2.0 / BSD / ISC 可直接用；GPL / AGPL 用于闭源或商用产品前必须先问用户；无许可证默认不可复用。
- 活跃度：近 12 个月有提交；已归档或停更 18 个月以上只能当参考实现。
- 体积：仓库 > 50 MB 不要 clone，用包管理器或 raw 读文件。
- 依赖规模：运行时依赖 > 30 个的在受限环境里容易装不上，优先零依赖实现。

## 常见坑

- 不要凭记忆写库的 API：先 `github_read` 看真实签名。
- 不要 clone：磁盘紧张，且 clone 下来的代码你还得自己维护。
- 注意 ESM/CJS 与 Node 版本要求，看 `package.json` 的 `engines` / `type`。
- monorepo 仓库的根 package.json 往往只是壳，真正的包在 `packages/*` 下，用 `paths` 参数指过去。
- 取用源码片段时保留原始 LICENSE 与出处注释。
