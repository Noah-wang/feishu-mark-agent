"""
B站用户视频字幕批量抓取工具（v3 - 完整支持 AI 字幕）
用法: python fetch_bilibili_subtitles.py <用户UID> [--sessdata x] [--bili_jct x] [--buvid3 x]
"""

import asyncio
import json
import sys
import argparse
from pathlib import Path

import httpx
from bilibili_api import user, Credential

# ========== 配置 ==========
CONFIG_FILE = Path(__file__).parent / "bilibili_config.json"
OUTPUT_DIR = Path(__file__).parent.parent / "减脂知识"
REQUEST_INTERVAL = 2.0
MAX_RETRIES = 3
RETRY_DELAY = 10
# ==========================


def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(config: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    print(f"  Cookie 已保存到 {CONFIG_FILE}")


def get_credential(args) -> Credential:
    config = load_config()
    sessdata = args.sessdata or config.get("sessdata", "")
    bili_jct = args.bili_jct or config.get("bili_jct", "")
    buvid3 = args.buvid3 or config.get("buvid3", "")

    if not sessdata:
        print("=" * 50)
        print("需要 B 站登录 Cookie")
        print("F12 → Application → Cookies → bilibili.com")
        print("=" * 50)
        sessdata = input("SESSDATA: ").strip()
        bili_jct = input("BILI_JCT: ").strip()
        buvid3 = input("BUVID3: ").strip()
        save_config({"sessdata": sessdata, "bili_jct": bili_jct, "buvid3": buvid3})

    return Credential(sessdata=sessdata, bili_jct=bili_jct, buvid3=buvid3)


def make_headers(cred: Credential) -> dict:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com",
        "Cookie": f"SESSDATA={cred.sessdata}; BILI_JCT={cred.bili_jct}; buvid3={cred.buvid3}",
    }


async def get_user_videos(uid: int, headers: dict) -> list:
    """通过 bilibili_api 获取用户所有视频"""
    cred = Credential(
        sessdata=headers.get("Cookie", "").split("SESSDATA=")[1].split(";")[0],
        bili_jct=headers.get("Cookie", "").split("BILI_JCT=")[1].split(";")[0],
        buvid3=headers.get("Cookie", "").split("buvid3=")[1].split(";")[0],
    )
    u = user.User(uid, credential=cred)
    all_videos = []
    page = 1

    while True:
        try:
            page_data = await u.get_videos(ps=30, pn=page)
            vlist = page_data.get("list", {}).get("vlist", [])
            if not vlist:
                break
            all_videos.extend(vlist)
            print(f"  第 {page} 页，累计 {len(all_videos)} 个")
            page += 1
            await asyncio.sleep(1)
        except Exception as e:
            if "412" in str(e):
                print(f"  触发风控，停止翻页")
            else:
                print(f"  获取第 {page} 页失败: {e}")
            break

    return all_videos


async def get_playview(bvid: str, headers: dict) -> dict:
    """获取视频基本信息（aid, cid, title）"""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
            headers=headers, timeout=15
        )
        return r.json()


async def get_subtitle_tracks(aid, cid, bvid, headers: dict) -> list:
    """从 player API 获取字幕轨（含 AI 字幕）"""
    async with httpx.AsyncClient() as c:
        # 主接口: player/wbi/v2
        url = f"https://api.bilibili.com/x/player/wbi/v2?aid={aid}&cid={cid}&bvid={bvid}"
        r = await c.get(url, headers=headers, timeout=15)
        d = r.json()
        if d.get("code") == 0:
            subs = d.get("data", {}).get("subtitle", {}).get("subtitles", [])
            if subs:
                return subs

        # 回退: player/v2
        url2 = f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}"
        r2 = await c.get(url2, headers=headers, timeout=15)
        d2 = r2.json()
        if d2.get("code") == 0:
            return d2.get("data", {}).get("subtitle", {}).get("subtitles", [])
        return []


async def get_subtitle_body(url: str, headers: dict) -> list:
    """下载字幕 JSON 内容"""
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
    parser = argparse.ArgumentParser(description="抓取 B 站用户所有视频字幕")
    parser.add_argument("uid", type=int, help="用户 UID")
    parser.add_argument("--sessdata")
    parser.add_argument("--bili_jct")
    parser.add_argument("--buvid3")
    parser.add_argument("--dir", default="减脂知识", help="输出目录名（默认: 减脂知识）")
    args = parser.parse_args()

    credential = get_credential(args)
    headers = make_headers(credential)

    # 1. 获取用户信息
    u = user.User(args.uid, credential=credential)
    try:
        info = await u.get_user_info()
        uname = info.get("name", "未知用户")
    except Exception as e:
        print(f"获取用户失败: {e}")
        return
    print(f"\n目标用户: {uname} (UID: {args.uid})")

    # 2. 获取视频列表
    print("\n正在获取视频列表...")
    videos = await get_user_videos(args.uid, headers)
    print(f"共找到 {len(videos)} 个视频\n")

    if not videos:
        return

    user_dir = OUTPUT_DIR.parent / args.dir / f"{uname}_{args.uid}"
    user_dir.mkdir(parents=True, exist_ok=True)

    success = 0
    no_subs = 0
    errors = 0

    for idx, v in enumerate(videos, 1):
        bvid = v["bvid"]
        title = v.get("title", "").strip()
        safe = "".join(c if c not in r'\/:*?"<>|' else "_" for c in title)[:60]

        print(f"[{idx}/{len(videos)}] {title}")

        # 获取 aid, cid
        pv = await get_playview(bvid, headers)
        if pv.get("code") != 0:
            errors += 1
            print(f"   跳过（API 错误）")
            await asyncio.sleep(REQUEST_INTERVAL)
            continue

        aid = pv["data"]["aid"]
        cid = pv["data"]["cid"]

        # 获取字幕轨（仅保留中文）
        tracks = await get_subtitle_tracks(aid, cid, bvid, headers)
        tracks = [t for t in tracks if "中文" in t.get("lan_doc", "") or t.get("lan", "").startswith("ai-zh")]
        if not tracks:
            no_subs += 1
            await asyncio.sleep(REQUEST_INTERVAL)
            continue

        saved = False
        for t in tracks:
            lang = t.get("lan_doc", "未知")
            sub_url = t.get("subtitle_url", "")
            if not sub_url:
                continue
            body = await get_subtitle_body(sub_url, headers)
            texts = [i.get("content", "") for i in body if i.get("content")]
            if texts:
                fp = user_dir / f"{safe}_{lang}.txt"
                fp.write_text("\n".join(texts), encoding="utf-8")
                print(f"    {lang} ({len(texts)} lines)")
                saved = True

        if saved:
            success += 1
        else:
            no_subs += 1

        await asyncio.sleep(REQUEST_INTERVAL)

    print(f"\n{'=' * 40}")
    print(f"完成！字幕: {success}/{len(videos)} 个视频")
    print(f"保存到: {user_dir}")
    if success > 0:
        print("内容已存入知识库，我下次能检索到")


if __name__ == "__main__":
    asyncio.run(main())
