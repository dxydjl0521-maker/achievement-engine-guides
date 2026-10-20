# Achievement Engine 社区攻略仓库

本仓库用于《成就引擎》社区攻略的校验、人工审核与版本发布，目前为私有试运行。`catalog/index.json` 只列出审核通过并发布的攻略；投稿进入 `submissions/` 分支和 PR，PR 中按攻略单元保存变更。技术检查通过后由维护者审阅和批准，合并到 `main` 才触发重新校验与发布。

同一游戏和语言可以收录多个独立攻略系列（不同 `guideId`）；同一系列的版本更新基于该 `guideId` 的最新已发布版本。

攻略内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可。单攻略上传上限为十进制 500 MB，单个文件上限为 100 MB。服务端会流式接收包体，并逐张解码、重新编码图片，清除元数据后才将净化后的攻略包写入草稿 Release。完整服务配置及上线条件见主项目的 `community-service/README.md`。

仓库初始化后还需安装仅限本仓库的 GitHub App，并配置仓库变量 `GUIDE_APP_VERSION`（如 `0.8.5`）。校验工作流只需读取权限，发布工作流需要 `contents: write` 和 `pull-requests: read`。`dxydjl0521-maker` 提交的攻略可以由本人合并发布；其他投稿须由 `dxydjl0521-maker` 或 `DXYDJL` 对最终 PR 提交批准，之后由有仓库写入权限的账号合并。自动规则范围与无法自动判断的内容见 `policy/content-policy.md`。
