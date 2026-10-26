# dsh-github-reuse

> 让 DSH 的 agent 先查 GitHub，再动手写代码：检索成熟开源项目、体检候选、确认依赖与真实 API，然后**优先装包集成，而不是从零实现**。

全程只走 HTTP（GitHub REST API + raw 文件通道），**不 clone 任何仓库**，几乎不占磁盘。

## 它解决什么问题

默认情况下，AI 面对一个需求会直接开写。结果是你得到一份自己造、没人维护、还可能有坑的实现。
这个插件把流程改成：

1. **先检索**：这个能力别人已经开源过了吗？
2. **再体检**：star、许可证、最近更新、仓库体积、依赖规模能不能接受？
3. **确认 API**：读真实的类型定义和示例，而不是凭记忆猜函数名。
4. **才动手**：装包集成（`npm i` / `pnpm add` / `pip install`），而不是复制整个仓库。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `github_search` | 检索仓库，支持 star 下限、语言、许可证、最近推送天数、topic 过滤与排序 |
| `github_inspect` | 仓库体检：star/fork/issue、语言、最近推送、体积、归档状态、许可证、最新 release、依赖概况、README 摘要、复用建议 |
| `github_tree_and_manifest` | 在线读取根目录依赖清单（package.json / pyproject.toml / requirements.txt / Cargo.toml / go.mod / composer.json / pubspec.yaml / Gemfile），给出依赖数、明细与装包命令 |
| `github_read` | 读取仓库内任意文本文件（raw 通道，不消耗 API 配额），确认导出 API / 示例 / 许可证 |

另外注入：

- 一段**系统提示词**：硬性门槛（动手前必须给出 ≥2 个开源候选或说明检索无果）+ 选型规则；
- 一个**技能 `oss-reuse`**：完整工作流（需求拆解 → 分区检索 → 体检对比 → 确认 API → 试集成 → 记录决策）。

## 安装

DSH 插件以 profile 组合包的形式加载。克隆或下载本仓库后：

```powershell
# 1) 把插件目录放到 profile 里
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item . "$p\.dsh-github-reuse" -Recurse

# 2) 建立 node_modules 链接
cmd /c mklink /J "$p\node_modules\dsh-github-reuse" "$p\.dsh-github-reuse"

# 3) 在 $p\package.json 里登记
#    dependencies 加   "dsh-github-reuse": "link:.dsh-github-reuse"
#    dsh.profile.bundles 末尾加 "dsh-github-reuse"

# 4) 重启 DSH
```

也可以放进任意 profile，把上面命令里的 `desktop` 换成目标 profile 名。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里加 config：

```yaml
- id: github-reuse
  config:
    token: 'ghp_xxxxxxxx'   # 也可用环境变量 GITHUB_TOKEN / GH_TOKEN / GITHUB_API_TOKEN
    timeoutMs: 30000        # 单次 HTTP 超时（毫秒）
    retries: 3              # 网络失败重试次数
    concurrency: 4          # 清单文件并发探测数
    maxOutputChars: 16000   # 单个工具输出上限（字符）
```

## 配额与降级

- 匿名调用：核心 API 60 次/小时、搜索 10 次/分钟；配置 token 后 5000 次/小时。
- `github_read`、`github_tree_and_manifest` 走 raw 通道，**不受 API 配额限制**。
- API 不可用时，`github_inspect` 会自动降级为 raw 通道体检（缺少 star / 提交时间等信息，会在结果里注明）。
- 网络抖动会自动重试（默认 3 次，退避 400ms × 次数），并限制并发，规避连接超时。

## 已知限制

- 只读公开仓库；私有仓库需要 token 且该 token 有对应权限。
- 不做代码搜索（GitHub Code Search API 需要认证），需要定位具体实现时用 `github_read` 直接读文件。
- 输出已做长度截断，超长文件请用 `startLine` / `maxLines` 分段读取。

## 许可证

[MIT](./LICENSE)
