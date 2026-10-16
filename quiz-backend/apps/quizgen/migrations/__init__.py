"""quizgen 的迁移。

为什么这里不是 Django `makemigrations` 生成的那个**空文件**：
空文件在 SFTP 上传时会被当成"远端已有 0 字节，跳过"（`renwu/tools/rexec.py` 的
`put_resumable`；那个 bug 2026-10-12 已修），部署脚本核对 sha256 时表现为"传输不一致"，
`deploy_quizgen_app.py --migrate` 会中止在核对那一步。留一句说明既省事又有用：
**这张表是刷题站的账号进度**（见 `apps/quizgen/models.py`）。
"""
