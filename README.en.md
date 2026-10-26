# dsh-github-reuse

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that makes the agent **search GitHub before it starts writing code**.

Instead of re-inventing a feature, the agent looks for a mature open-source implementation, checks it (stars, license, freshness, size, dependency weight), verifies the real exported API, and then integrates it — preferably by installing a package rather than vendoring a whole repository.

All access is plain HTTP (GitHub REST API + `raw.githubusercontent.com`). **Nothing is ever cloned**, so it costs essentially no disk space.

## Tools

| Tool | Purpose |
| --- | --- |
| `github_search` | Search repositories with filters: minimum stars, language, license, pushed-within-days, topic; sort by best match / stars / updated |
| `github_inspect` | Repo health check: stars, forks, open issues, language, last push, repo size, archived flag, license, latest release, dependency summary, README excerpt, reuse verdict |
| `github_tree_and_manifest` | Read root manifests online (`package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `composer.json`, `pubspec.yaml`, `Gemfile`) and report dependency counts plus the install command |
| `github_read` | Read any text file in a repo through the raw channel (no API quota), to verify exported APIs, examples and license text |

The plugin also injects a **system-prompt section** (a hard gate: list at least two open-source candidates, or prove the search came up empty, before writing custom code) and ships an **`oss-reuse` skill** describing the full workflow.

## Install

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item . "$p\.dsh-github-reuse" -Recurse
cmd /c mklink /J "$p\node_modules\dsh-github-reuse" "$p\.dsh-github-reuse"
# then add "dsh-github-reuse": "link:.dsh-github-reuse" to dependencies
# and "dsh-github-reuse" to dsh.profile.bundles in $p\package.json
# finally restart DSH
```

## Configuration (optional)

```yaml
- id: github-reuse
  config:
    token: 'ghp_xxxxxxxx'   # or GITHUB_TOKEN / GH_TOKEN / GITHUB_API_TOKEN
    timeoutMs: 30000
    retries: 3
    concurrency: 4
    maxOutputChars: 16000
```

## Quotas

Anonymous GitHub access allows 60 core requests/hour and 10 searches/minute; a token raises this to 5000/hour. `github_read` and `github_tree_and_manifest` use the raw channel and are not affected by API quotas. When the API is unavailable, `github_inspect` degrades to raw-only inspection and says so in its output.

## License

[MIT](./LICENSE)
