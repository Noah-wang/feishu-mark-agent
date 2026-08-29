"""
单视频字幕提取工具
用法: python fetch_single_video_subtitle.py <avid|bvid> --dir <输出目录>
示例: python fetch_single_video_subtitle.py 12345678 --dir 经济类
       python fetch_single_video_subtitle.py BV1xx411c7mD --dir 减脂知识

依赖: pip install bilibili-api-python httpx
"""
import asyncio, json, os, sys, re
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
import httpx
from bilibili_api import video, Credential

CONFIG_FILE = Path(os.environ.get("BILIBILI_CONFIG_FILE", Path(__file__).parent.parent / "bilibili_config.json"))


def load_credential() -> Credential | None:
    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return Credential(
            sessdata=cfg.get("sessdata", ""),
            bili_jct=cfg.get("bili_jct", ""),
            buvid3=cfg.get("buvid3", ""),
        )
    return None


async def get_subtitle_tracks(aid, cid, bvid, headers):
    async with httpx.AsyncClient() as c:
        url = f"https://api.bilibili.com/x/player/wbi/v2?aid={aid}&cid={cid}&bvid={bvid}"
        r = await c.get(url, headers=headers, timeout=15)
        d = r.json()
        if d.get("code") == 0:
            subs = d.get("data", {}).get("subtitle", {}).get("subtitles", [])
            if subs:
                return subs
        url2 = f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}"
        r2 = await c.get(url2, headers=headers, timeout=15)
        d2 = r2.json()
        if d2.get("code") == 0:
            return d2.get("data", {}).get("subtitle", {}).get("subtitles", [])
    return []


async def get_subtitle_body(url, headers):
    if url.startswith("//"):
        url = "https:" + url
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(url, headers=headers, timeout=15)
            if r.status_code == 200:
                return r.json().get("body", [])
        except:
            pass
    return []


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="抓取单个 B 站视频字幕")
    parser.add_argument("avid", type=str, help="视频 AV 号或 BV 号")
    parser.add_argument("--dir", default="减脂知识", help="输出目录名（默认: 减脂知识）")
    args = parser.parse_args()

    cred = load_credential()
    if not cred:
        print("请先配置 bilibili_config.json（含 sessdata / bili_jct / buvid3）")
        return

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com",
        "Cookie": f"SESSDATA={cred.sessdata}; BILI_JCT={cred.bili_jct}; buvid3={cred.buvid3}",
    }

    # 支持 AV 号或 BV 号
    raw = args.avid.strip()
    if raw.startswith("BV") or raw.startswith("bv"):
        v = video.Video(bvid=raw, credential=cred)
    else:
        v = video.Video(aid=int(raw), credential=cred)

    info = await v.get_info()
    title = info["title"]
    bvid = info["bvid"]
    cid = info["cid"]
    owner_name = info["owner"]["name"]
    owner_uid = info["owner"]["mid"]
    print(f"视频: {title}")
    print(f"UP主: {owner_name} (UID: {owner_uid})")

    # 获取字幕轨（仅中文）
    tracks = await get_subtitle_tracks(info["aid"], cid, bvid, headers)
    cn_tracks = [t for t in tracks if "中文" in t.get("lan_doc", "") or t.get("lan", "").startswith("ai-zh")]
    if not cn_tracks:
        print("无中文字幕")
        return

    # 输出目录
    output_base = Path(__file__).parent.parent / args.dir
    safe_title = re.sub(r'[\\/:*?"<>|]', '_', title)[:60]
    author_dir = output_base / f"{owner_name}_{owner_uid}"
    author_dir.mkdir(parents=True, exist_ok=True)

    for t in cn_tracks:
        lang = t.get("lan_doc", "中文")
        sub_url = t.get("subtitle_url", "")
        if not sub_url:
            continue
        body = await get_subtitle_body(sub_url, headers)
        texts = [i["content"] for i in body if i.get("content")]
        if texts:
            fp = author_dir / f"{safe_title}_{lang}.txt"
            fp.write_text("\n".join(texts), encoding="utf-8")
            print(f"  OK {lang} ({len(texts)} 条)")
        await asyncio.sleep(0.5)

    print(f"\n保存到: {author_dir}")

    # 更新 INDEX.md（在对应 section 末尾添加条目）
    index_path = output_base.parent / "INDEX.md"
    if index_path.exists():
        content = index_path.read_text(encoding="utf-8")
        entry = f"- [{owner_name}(UID:{owner_uid})]({args.dir}/{owner_name}_{owner_uid}/)"
        if entry not in content:
            section_header = f"## {args.dir} —"
            lines = content.split("\n")
            idx = -1
            for i, ln in enumerate(lines):
                if ln.startswith(section_header):
                    idx = i
            if idx >= 0:
                # 找到 section 内已有条目末尾
                insert_at = idx + 1
                while insert_at < len(lines) and lines[insert_at].startswith("- ["):
                    insert_at += 1
                lines.insert(insert_at, entry)
                index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                print("INDEX.md 已更新")


if __name__ == "__main__":
    asyncio.run(main())
