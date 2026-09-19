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
from html.parser import HTMLParser

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

# 网络抖动、限流或 Canvas 服务端临时错误时的最大尝试次数
MAX_REQUEST_ATTEMPTS = int(os.environ.get("MAX_REQUEST_ATTEMPTS", "3"))
RETRY_BASE_DELAY = float(os.environ.get("RETRY_BASE_DELAY", "2"))

OUT_DIR = os.environ.get("OUT_DIR", "dist")


def build_url(path, params=None):
    """构造 Canvas API URL。"""
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    return url


def request_json(url):
    """带重试的 GET 请求，返回 JSON 和响应头。"""
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    })

    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                return payload, resp.headers
        except urllib.error.HTTPError as exc:
            # 认证、权限等客户端错误重试没有意义；限流除外。
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt == MAX_REQUEST_ATTEMPTS:
                raise
            retry_after = exc.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else RETRY_BASE_DELAY * (2 ** (attempt - 1))
        except (urllib.error.URLError, TimeoutError):
            if attempt == MAX_REQUEST_ATTEMPTS:
                raise
            delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))

        print(f"[warn] 请求失败，{delay:g} 秒后进行第 {attempt + 1}/{MAX_REQUEST_ATTEMPTS} 次尝试: {url}", file=sys.stderr)
        time.sleep(delay)


def api_get(path, params=None):
    """带 token 的 GET 请求，返回解析后的 JSON。"""
    payload, _ = request_json(build_url(path, params))
    return payload


def page_all(path, params=None, key="data"):
    """处理 Canvas 的 Link 头分页，把所有页拉全。"""
    url = build_url(path, params)
    all_items = []
    while url:
        items, headers = request_json(url)
        # 兼容返回列表 或 {"data": [...]}
        if isinstance(items, dict):
            items = items.get(key, [])
        if not isinstance(items, list):
            raise ValueError(f"Canvas API 返回了非列表数据: {url}")
        all_items.extend(items)
        # 取下一页
        url = _next_url(headers.get("Link", ""))
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


def json_for_html_script(value):
    """将 JSON 安全地放进 HTML 的 script 文本节点。"""
    return (
        json.dumps(value, ensure_ascii=False)
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def assignment_title(assignment):
    """兼容 Canvas 正式字段 name 与部分实例可能返回的 title。"""
    title = assignment.get("name") or assignment.get("title") or ""
    return str(title).strip() or "未命名作业"


def assignment_completion(assignment):
    """返回当前用户是否已完成作业，以及可展示的 Canvas 状态。"""
    submission = assignment.get("submission") or {}
    state = str(submission.get("workflow_state") or "unsubmitted").lower()
    if submission.get("excused"):
        return True, "excused"
    completed = bool(
        submission.get("submitted_at")
        or state in {"submitted", "graded", "pending_review"}
    )
    return completed, state


def assignment_type(assignment):
    """识别 Assignments API 中承载的普通作业、测验和评分讨论。"""
    submission_types = set(assignment.get("submission_types") or [])
    if assignment.get("is_quiz_assignment") or "online_quiz" in submission_types:
        return "quiz", "测验"
    if "discussion_topic" in submission_types:
        return "discussion_topic", "讨论"
    return "assignment", "作业"


PLANNER_TYPE_LABELS = {
    "announcement": "公告",
    "assignment": "作业",
    "assessment_request": "互评",
    "calendar_event": "日程",
    "discussion_topic": "讨论",
    "peer_review_sub_assignment": "互评",
    "planner_note": "待办",
    "quiz": "测验",
    "sub_assignment": "子任务",
    "wiki_page": "页面",
}


def planner_item_completion(item):
    """使用 Planner 覆盖状态和当前用户提交状态判断是否完成。"""
    override = item.get("planner_override") or {}
    if override.get("marked_complete"):
        return True, "planner_marked_complete"

    submission = item.get("submissions") or {}
    if not isinstance(submission, dict):
        return False, "unsubmitted"
    if submission.get("excused"):
        return True, "excused"
    completed_flags = ("submitted", "graded", "needs_grading", "with_feedback", "late")
    if any(submission.get(flag) for flag in completed_flags):
        return True, "submitted"
    return False, "missing" if submission.get("missing") else "unsubmitted"


def planner_item_to_output(item):
    """把不同类型的 Planner 对象统一成前端项目结构。"""
    plannable = item.get("plannable") or {}
    item_type = str(item.get("plannable_type") or "calendar_event").lower()
    item_id = item.get("plannable_id") or plannable.get("id")
    title = plannable.get("name") or plannable.get("title") or item.get("title") or "未命名项目"
    due_raw = (
        item.get("plannable_date")
        or plannable.get("due_at")
        or plannable.get("todo_date")
        or plannable.get("start_at")
        or plannable.get("end_at")
    )
    due_at = None
    if due_raw:
        try:
            due_at = datetime.fromisoformat(str(due_raw).replace("Z", "+00:00")).astimezone(LOCAL_TZ).isoformat()
        except (TypeError, ValueError):
            due_at = None
    completed, completion_state = planner_item_completion(item)
    html_url = str(item.get("html_url") or plannable.get("html_url") or "")
    if html_url.startswith("/"):
        html_url = f"{API_BASE}{html_url}"
    description = plannable.get("description") or plannable.get("details") or plannable.get("message") or ""
    assignment_id = plannable.get("assignment_id") or (item.get("planner_override") or {}).get("assignment_id")
    return {
        "id": f"{item_type}:{item_id}",
        "source_id": item_id,
        "assignment_id": assignment_id,
        "title": str(title).strip() or "未命名项目",
        "due_at": due_at,
        "completed": completed,
        "completion_state": completion_state,
        "item_type": item_type,
        "type_label": PLANNER_TYPE_LABELS.get(item_type, "其他"),
        "state": plannable.get("workflow_state"),
        "html_url": html_url,
        "description": str(description)[:600],
    }


class _PlainTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        text = data.strip()
        if text:
            self.parts.append(text)


def html_to_text(value):
    """把 Canvas 描述中的 HTML 转成适合提醒事项备注的纯文本。"""
    parser = _PlainTextParser()
    parser.feed(str(value or ""))
    return " ".join(parser.parts)


def build_reminders_data(data):
    """生成适合 Apple 快捷指令处理的扁平提醒数据。"""
    reminders = []
    for course in data.get("courses", []):
        for item in course.get("assignments", []):
            item_type = item.get("item_type") or "assignment"
            source_id = item.get("source_id") or item.get("id")
            uid = f"canvas:{course.get('id')}:{item_type}:{source_id}"
            due_at = item.get("due_at")
            # 此订阅只生成“截止提醒”；无截止时间的项目继续保留在网页中。
            if not due_at:
                continue
            due_for_shortcuts = None
            remind_at = None
            if due_at:
                try:
                    due_datetime = datetime.fromisoformat(due_at.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
                    # iOS 快捷指令在中文系统中不能稳定解析带时区的 ISO 8601 文本。
                    # 使用本地化的纯数字日期，可由“从输入中获取日期”可靠转换为日期对象。
                    due_for_shortcuts = due_datetime.strftime("%Y年%m月%d日 %H:%M")
                    remind_at = (due_datetime - timedelta(hours=24)).strftime("%Y年%m月%d日 %H:%M")
                except (AttributeError, TypeError, ValueError):
                    pass
            description = html_to_text(item.get("description"))[:400]
            notes = f"{item.get('type_label') or '作业'} · {course.get('name') or '未命名课程'}"
            if description:
                notes += f"\n{description}"
            notes += f"\n{uid}"
            reminders.append({
                "uid": uid,
                "title": f"[{course.get('name') or '课程'}] {item.get('title') or '未命名项目'}",
                "course": course.get("name") or "未命名课程",
                "type": item_type,
                "type_label": item.get("type_label") or "作业",
                "due_at": due_for_shortcuts,
                "remind_at": remind_at,
                "completed": bool(item.get("completed")),
                "url": item.get("html_url") or "",
                "notes": notes,
            })
    reminders.sort(key=lambda item: (item["due_at"] is None, item["due_at"] or "", item["title"]))
    return {
        "version": 1,
        "generated_at": data.get("generated_at"),
        "timezone_offset": data.get("timezone_offset"),
        "items": reminders,
    }


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
    courses = page_all("/api/v1/courses", {"enrollment_state": "active", "per_page": 100})
    print(f"[info] 在读课程数: {len(courses)}")
    time.sleep(REQUEST_DELAY)

    # Planner 是 Canvas 为学生待办和日历提供的统一接口，可补齐测验、讨论、日历事件等类型。
    planner_items = page_all(
        "/api/v1/planner/items",
        {
            "start_date": week_cutoff.isoformat(),
            "end_date": (now + timedelta(weeks=4)).isoformat(),
            "per_page": 100,
        },
    )
    planner_by_course = {}
    for planner_item in planner_items:
        course_id = planner_item.get("course_id")
        if course_id is not None:
            planner_by_course.setdefault(str(course_id), []).append(planner_item)
    print(f"[info] Planner 项目数: {len(planner_items)}")
    time.sleep(REQUEST_DELAY)

    out_courses = []
    failed_courses = []
    for c in courses:
        course_id = c.get("id")
        course_name = c.get("name") or "未命名课程"
        color = c.get("color") or "#888888"
        base_url = c.get("html_url") or f"{API_BASE}/courses/{course_id}"

        # 2) 拉该课程作业
        try:
            assignments = page_all(
                f"/api/v1/courses/{course_id}/assignments",
                {"per_page": MAX_ASSIGNMENTS_PER_COURSE, "completed": "false", "include[]": "submission"},
            )
        except Exception as e:
            print(f"[warn] 课程 {course_name} 拉作业失败: {e}", file=sys.stderr)
            failed_courses.append(course_name)
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
            completed, completion_state = assignment_completion(a)
            item_type, type_label = assignment_type(a)
            items.append({
                "id": a.get("id"),
                "title": assignment_title(a),
                "due_at": due_dt.isoformat(),
                "completed": completed,
                "completion_state": completion_state,
                "item_type": item_type,
                "type_label": type_label,
                "state": a.get("workflow_state"),
                "html_url": f"{base_url}/assignments/{a.get('id')}",
                "description": (a.get("description") or "")[:600],
            })
        # 也保留无截止时间的作业（如有），放最后
        for a in assignments:
            if not a.get("due_at"):
                completed, completion_state = assignment_completion(a)
                item_type, type_label = assignment_type(a)
                items.append({
                    "id": a.get("id"),
                    "title": assignment_title(a),
                    "due_at": None,
                    "completed": completed,
                    "completion_state": completion_state,
                    "item_type": item_type,
                    "type_label": type_label,
                    "state": a.get("workflow_state"),
                    "html_url": f"{base_url}/assignments/{a.get('id')}",
                    "description": (a.get("description") or "")[:600],
                })

        # 3) 合并 Planner 中非作业项目；有底层 assignment_id 的测验/讨论会与作业接口去重。
        existing_assignment_ids = {str(a.get("id")) for a in assignments if a.get("id") is not None}
        planner_added = 0
        for planner_item in planner_by_course.get(str(course_id), []):
            normalized = planner_item_to_output(planner_item)
            duplicate_assignment_id = normalized.get("assignment_id")
            if duplicate_assignment_id is None and normalized["item_type"] == "assignment":
                duplicate_assignment_id = normalized.get("source_id")
            if duplicate_assignment_id is not None and str(duplicate_assignment_id) in existing_assignment_ids:
                continue
            items.append(normalized)
            planner_added += 1

        if items:
            out_courses.append({
                "id": course_id,
                "name": course_name,
                "color": color,
                "assignments": items,
            })
        print(f"[info]   {course_name}: {len(items)} 个项目（Planner 补充 {planner_added}）")

    # 不发布缺课程的残缺数据；Actions 失败时，GitHub Pages 会保留上一版。
    if failed_courses:
        names = "、".join(failed_courses)
        raise RuntimeError(f"以下课程同步失败，已取消本次部署: {names}")

    # 3) 组装 data.json
    data = {
        "generated_at": now.isoformat(),
        "stale_after_hours": 36,
        "current_week_start": local_week_start(now).date().isoformat(),
        "timezone_offset": "+08:00",
        "courses": out_courses,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    data_path = os.path.join(OUT_DIR, "data.json")
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[ok] 已生成 {data_path}（课程 {len(out_courses)} 门）")

    reminders_path = os.path.join(OUT_DIR, "reminders.json")
    reminders_data = build_reminders_data(data)
    with open(reminders_path, "w", encoding="utf-8") as f:
        json.dump(reminders_data, f, ensure_ascii=False, indent=2)
    print(f"[ok] 已生成 {reminders_path}（提醒 {len(reminders_data['items'])} 条）")

    # 4) 渲染 index.html：把 data.json 内联进模板
    template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    with open(template_path, "r", encoding="utf-8") as f:
        template = f.read()
    # JSON 位于 <script> 中，必须转义 HTML 特殊字符，避免 Canvas 文本提前闭合脚本标签。
    inline_json = json_for_html_script(data)
    html = template.replace("__DATA_JSON__", inline_json)
    html_path = os.path.join(OUT_DIR, "index.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[ok] 已生成 {html_path}")

    guide_template = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apple-reminders.html")
    guide_output = os.path.join(OUT_DIR, "apple-reminders.html")
    with open(guide_template, "r", encoding="utf-8") as source, open(guide_output, "w", encoding="utf-8") as target:
        target.write(source.read())
    print(f"[ok] 已生成 {guide_output}")


if __name__ == "__main__":
    main()
