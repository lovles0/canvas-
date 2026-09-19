#!/usr/bin/env python3
"""
fetch_canvas.py — 从学校 Canvas 拉取课程与作业，生成 dist/data.json 和 dist/index.html。

运行方式（GitHub Actions 或本地）：
    export CANVAS_API_URL=https://oc.sjtu.edu.cn
    export CANVAS_TOKEN=***
    python fetch_canvas.py

说明：
- 只读操作，只调 GET 接口，不会修改 Canvas 任何数据。
- 使用 Python 标准库（urllib），无需 pip 安装第三方依赖，
  这样 GitHub Actions 用官方 ubuntu 镜像即可直接跑。
- 拉取范围：所有“在读”课程 + 最近 N 周（含历史）的作业。
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timedelta, timezone

# ---------- 配置 ----------
API_BASE = os.environ.get("CANVAS_API_URL", "").rstrip("/")
TOKEN = os.environ.get("CANVAS_TOKEN", "")

# 时区：学校（上海）为 UTC+8。所有“周”的划分按本地时区。
LOCAL_TZ = timezone(timedelta(hours=8))

# 往前取多少周的历史作业（含本周）。例如 8 表示本周 + 过去 7 周。
WEEKS_BACK = int(os.environ.get("WEEKS_BACK", "8"))

# 单门课程最多拉多少条作业（控制 data.json 体积）
MAX_ASSIGNMENTS_PER_COURSE = int(os.environ.get("MAX_ASSIGNMENTS", "100"))

# 请求间隔，避免触发 Canvas rate limit（秒）
REQUEST_DELAY = 0.5

OUT_DIR = os.environ.get("OUT_DIR", "dist")


def api_get(path, params=None):
    """带 token 的 GET 请求，返回解析后的 JSON。"""
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def page_all(path, params=None, key="data"):
    """处理 Canvas 的 Link 头分页，把所有页拉全。"""
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    all_items = []
    while url:
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            items = json.loads(resp.read().decode("utf-8"))
            # 兼容返回列表 或 {"data": [...]}
            if isinstance(items, dict):
                items = items.get(key, [])
            all_items.extend(items)
            # 取下一页
            url = resp.headers.get("Link", "")
            url = _next_url(url)
            if url:
                time.sleep(REQUEST_DELAY)
    return all_items


def _next_url(link_header):
    """解析 Link 头的 rel='next'。"""
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' in part:
            # 形如 <https://...>; rel="next"
            start = part.find("<")
            end = part.find(">")
            if start != -1 and end != -1:
                return part[start + 1:end]
    return None


def local_week_start(dt):
    """返回 dt 所在周的周一 00:00（本地时区）。"""
    return (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def main():
    if not API_BASE or not TOKEN:
        print("错误：环境变量 CANVAS_API_URL 或 CANVAS_TOKEN 未设置", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(LOCAL_TZ)
    week_cutoff = local_week_start(now) - timedelta(weeks=WEEKS_BACK - 1)

    print(f"[info] API: {API_BASE}")
    print(f"[info] 当前时间(本地): {now.isoformat()}")
    print(f"[info] 拉取范围起点(周一起): {week_cutoff.date()}")

    # 1) 拉所有在读课程
    courses = api_get("/api/v1/courses", {"enrollment_state": "active", "per_page": 100})
    print(f"[info] 在读课程数: {len(courses)}")
    time.sleep(REQUEST_DELAY)

    out_courses = []
    for c in courses:
        course_id = c.get("id")
        course_name = c.get("name") or "未命名课程"
        color = c.get("color") or "#888888"
        # account_id 用于跳转链接（Canvas 课程 html_url 可能为 null）
        account_id = c.get("account_id")
        base_url = c.get("html_url") or f"{API_BASE}/courses/{course_id}"

        # 2) 拉该课程作业
        try:
            assignments = page_all(
                f"/api/v1/courses/{course_id}/assignments",
                {"per_page": MAX_ASSIGNMENTS_PER_COURSE, "completed": "false", "include[]": "submission"},
            )
        except Exception as e:
            print(f"[warn] 课程 {course_name} 拉作业失败: {e}", file=sys.stderr)
            assignments = []
        time.sleep(REQUEST_DELAY)

        items = []
        for a in assignments:
            due_raw = a.get("due_at")
            if not due_raw:
                continue  # 无截止时间的作业单独处理（仍保留，due_at=null）
            try:
                due_dt = datetime.fromisoformat(due_raw.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
            except Exception:
                continue
            # 只保留范围内的作业（历史 + 未来少量）
            if due_dt < week_cutoff or due_dt > now + timedelta(weeks=4):
                continue
            items.append({
                "id": a.get("id"),
                "title": a.get("title") or "未命名作业",
                "due_at": due_dt.isoformat(),
                "submitted": bool(a.get("submission", {}).get("submitted_at")) if a.get("submission") else False,
                "state": a.get("state"),
                "html_url": f"{base_url}/assignments/{a.get('id')}",
                "description": (a.get("description") or "")[:600],
            })
        # 也保留无截止时间的作业（如有），放最后
        for a in assignments:
            if not a.get("due_at"):
                items.append({
                    "id": a.get("id"),
                    "title": a.get("title") or "未命名作业",
                    "due_at": None,
                    "submitted": bool(a.get("submission", {}).get("submitted_at")) if a.get("submission") else False,
                    "state": a.get("state"),
                    "html_url": f"{base_url}/assignments/{a.get('id')}",
                    "description": (a.get("description") or "")[:600],
                })

        if items:
            out_courses.append({
                "id": course_id,
                "name": course_name,
                "color": color,
                "assignments": items,
            })
        print(f"[info]   {course_name}: {len(items)} 条作业")

    # 3) 组装 data.json
    data = {
        "generated_at": now.isoformat(),
        "current_week_start": local_week_start(now).date().isoformat(),
        "timezone_offset": "+08:00",
        "courses": out_courses,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    data_path = os.path.join(OUT_DIR, "data.json")
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[ok] 已生成 {data_path}（课程 {len(out_courses)} 门）")

    # 4) 渲染 index.html：把 data.json 内联进模板
    template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    with open(template_path, "r", encoding="utf-8") as f:
        template = f.read()
    html = template.replace("__DATA_JSON__", json.dumps(data, ensure_ascii=False))
    html_path = os.path.join(OUT_DIR, "index.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[ok] 已生成 {html_path}")


if __name__ == "__main__":
    main()
