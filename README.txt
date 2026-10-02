双甜点 · GitHub Pages 静态站点

把本目录的全部内容（包括 .github/workflows/pages.yml 与 .nojekyll）上传到仓库根目录，保留各级目录。
仓库 Settings → Pages → Source 选择 GitHub Actions。推送 main 或手动运行 pages 工作流部署。
本地文件双击打开不适用于此版本；它需要 HTTPS/HTTP 静态网站托管，无需 Python/API 服务。

页面先载入清单并静默准备初始声场；就绪后点击‘开始试听’或播放按钮。不会自动播放。默认选中清单中的第一首音乐。
播放过程中保留两方案、左右座位、28点移动、中心 0 至 −5dB（默认−1.5dB）及单区−2dB。也可导入自己的本地音乐，本地导入不会上传。

现有歌曲按原始文件字节复制，不转码。响应文件按需请求，不要求下载完整声场库后才开始试听。
生成命令：python build_github_pages.py --music all
可指定部分曲目及顺序：python build_github_pages.py --music 00_original_demo.wav

构建记录见 build-info.json。构建器未运行浏览器、音频或软件测试；运行验证由另一步完成。
