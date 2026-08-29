# B站字幕抓取工具 / Bilibili Subtitle Fetcher

批量或单个抓取 B 站视频字幕，保存为纯文本文件，直接存入知识库。

## 功能

- **批量抓取** — 输入用户 UID，自动拉取该 UP 主所有视频的字幕
- **单视频抓取** — 输入视频 AV 号或 BV 号，抓取单个视频的字幕
- **自动识别中文** — 只保存中文字幕（含 AI 生成字幕）
- **Cookie 缓存** — 首次输入 B 站登录 Cookie 后自动保存，后续免输入
- **知识库集成** — 字幕按 `UP主名_UID` 分目录保存，自动更新 INDEX.md

## 环境要求

- Python 3.10+
- 依赖：`bilibili-api-python`、`httpx`

```bash
pip install bilibili-api-python httpx
```

## 使用教程

### 1. 获取 B 站 Cookie（首次使用）

打开浏览器，登录 bilibili.com，按 F12 → Application → Cookies → bilibili.com，复制以下三个值：

- `SESSDATA`
- `BILI_JCT`  
- `BUVID3`

运行脚本时首次会提示输入，输入一次后自动保存，以后不再提示。

### 2. 批量抓取（按 UID）

抓取某个 UP 主所有视频的字幕：

```bash
python fetch_bilibili_subtitles.py <UID> --dir <分类目录>
```

示例：

```bash
python fetch_bilibili_subtitles.py <UID> --dir 经济类
```

字幕将保存到 `../<分类目录>/<UP主名_UID>/`。

### 3. 单视频抓取（按 AV/BV 号）

抓取单个视频的字幕：

```bash
python fetch_single_video_subtitle.py <AV号或BV号> --dir <分类目录>
```

示例：

```bash
python fetch_single_video_subtitle.py 12345678 --dir 经济类
python fetch_single_video_subtitle.py BV1xx411c7mD --dir 减脂知识
```

## 输出结构

```
知识库根目录/
├── 分类目录A/
│   └── UP主名_UID/
│       ├── 视频标题1_中文.txt
│       └── 视频标题2_中文.txt
├── 分类目录B/
│   └── UP主名_UID/
└── INDEX.md          ← 自动更新
```

每个字幕文件为纯文本格式，每行一条字幕内容，方便检索和阅读。

## 注意事项

- `bilibili_config.json` 包含你的登录 Cookie，不会提交到 Git
- 抓取间隔为 2 秒/视频，避免触发风控
- 部分视频无字幕时会自动跳过
- 目前仅支持提取**中文字幕**（含 AI 字幕）

## License

MIT
