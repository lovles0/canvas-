import json
import contextlib
import io
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fetch_canvas


class FetchCanvasTests(unittest.TestCase):
    def test_sync_public_config_fallback_and_legacy_env_override(self):
        public_config = {"supabase_url": "https://public.supabase.co", "supabase_anon_key": "sb_publishable_test"}
        for env_url, env_key, expected_url, expected_key in (
            ("", "", "https://public.supabase.co", "sb_publishable_test"),
            ("https://legacy.supabase.co/", "legacy-anon", "https://legacy.supabase.co", "legacy-anon"),
            ("https://legacy.supabase.co", "", "https://legacy.supabase.co", ""),
            ("", "legacy-anon", "", "legacy-anon"),
        ):
            with self.subTest(env_url=env_url), tempfile.TemporaryDirectory() as output:
                with mock.patch.object(fetch_canvas, "API_BASE", "https://canvas.example"), \
                     mock.patch.object(fetch_canvas, "TOKEN", "test-only-token"), \
                     mock.patch.object(fetch_canvas, "OUT_DIR", output), \
                     mock.patch.object(fetch_canvas, "page_all", return_value=[]), \
                     mock.patch.object(fetch_canvas.time, "sleep"), \
                     mock.patch.object(fetch_canvas.json, "load", return_value=public_config), \
                     mock.patch.dict(os.environ, {"SUPABASE_URL": env_url, "SUPABASE_ANON_KEY": env_key}), \
                     contextlib.redirect_stdout(io.StringIO()):
                    fetch_canvas.main()
                html = Path(output, "index.html").read_text(encoding="utf-8")
                config = json.loads(re.search(r'<script[^>]*id="sync-config"[^>]*>(.*?)</script>', html, re.S).group(1))
                self.assertEqual(config["supabase_url"], expected_url)
                self.assertEqual(config["supabase_anon_key"], expected_key)

    def test_manual_refresh_metadata_is_published_without_secrets(self):
        request_id = "c1541234-1234-4123-8123-123456789abc"
        with tempfile.TemporaryDirectory() as output:
            with mock.patch.object(fetch_canvas, "API_BASE", "https://canvas.example"), \
                 mock.patch.object(fetch_canvas, "TOKEN", "test-only-canvas-token"), \
                 mock.patch.object(fetch_canvas, "OUT_DIR", output), \
                 mock.patch.object(fetch_canvas, "page_all", return_value=[]), \
                 mock.patch.object(fetch_canvas.time, "sleep"), \
                 mock.patch.dict(os.environ, {"CANVAS_REFRESH_REQUEST_ID": request_id, "GITHUB_RUN_ID": "42", "CANVAS_REFRESH_URL": "https://project.supabase.co/functions/v1/canvas-refresh", "GITHUB_ACTIONS_TOKEN": "test-only-secret"}), \
                 contextlib.redirect_stdout(io.StringIO()):
                fetch_canvas.main()
            data = json.loads(Path(output, "data.json").read_text(encoding="utf-8"))
            self.assertEqual(data.get("refresh_request_id"), request_id)
            self.assertEqual(data.get("workflow_run_id"), "42")
            html = Path(output, "index.html").read_text(encoding="utf-8")
            self.assertIn("https://project.supabase.co/functions/v1/canvas-refresh", html)
            self.assertNotIn("test-only-secret", html)
            self.assertNotIn("test-only-canvas-token", html)
            self.assertTrue(Path(output, "refresh.js").is_file())

    def test_default_future_window_is_twelve_weeks(self):
        self.assertEqual(fetch_canvas.WEEKS_FORWARD, 12)

    def test_page_all_follows_canvas_next_links(self):
        responses = [
            ([{"id": 1}], {"Link": '<https://canvas.example/items?page=2>; rel="next"'}),
            ([{"id": 2}], {}),
        ]
        with mock.patch.object(fetch_canvas, "request_json", side_effect=responses) as request_json:
            with mock.patch.object(fetch_canvas.time, "sleep"):
                items = fetch_canvas.page_all("/items", {"per_page": 100})

        self.assertEqual([item["id"] for item in items], [1, 2])
        self.assertEqual(request_json.call_count, 2)
        self.assertEqual(request_json.call_args_list[1].args[0], "https://canvas.example/items?page=2")

    def test_assignment_title_prefers_canvas_name(self):
        assignment = {"name": "实验报告", "title": "旧字段标题"}
        self.assertEqual(fetch_canvas.assignment_title(assignment), "实验报告")

    def test_assignment_title_falls_back_to_title(self):
        self.assertEqual(fetch_canvas.assignment_title({"title": "课程论文"}), "课程论文")

    def test_assignment_title_handles_blank_values(self):
        self.assertEqual(fetch_canvas.assignment_title({"name": "   "}), "未命名作业")

    def test_assignment_completion_recognizes_canvas_states(self):
        for state in ("submitted", "graded", "pending_review"):
            completed, returned_state = fetch_canvas.assignment_completion(
                {"submission": {"workflow_state": state}}
            )
            self.assertTrue(completed)
            self.assertEqual(returned_state, state)

    def test_assignment_completion_recognizes_excused(self):
        self.assertEqual(
            fetch_canvas.assignment_completion({"submission": {"excused": True}}),
            (True, "excused"),
        )

    def test_assignment_completion_keeps_unsubmitted_open(self):
        self.assertEqual(
            fetch_canvas.assignment_completion({"submission": {"workflow_state": "unsubmitted"}}),
            (False, "unsubmitted"),
        )

    def test_assignment_type_recognizes_quiz_and_discussion(self):
        self.assertEqual(fetch_canvas.assignment_type({"is_quiz_assignment": True}), ("quiz", "测验"))
        self.assertEqual(
            fetch_canvas.assignment_type({"submission_types": ["discussion_topic"]}),
            ("discussion_topic", "讨论"),
        )

    def test_planner_completion_uses_submission_and_override(self):
        self.assertEqual(
            fetch_canvas.planner_item_completion({"planner_override": {"marked_complete": True}}),
            (True, "planner_marked_complete"),
        )
        self.assertEqual(
            fetch_canvas.planner_item_completion({"submissions": {"needs_grading": True}}),
            (True, "submitted"),
        )
        self.assertEqual(
            fetch_canvas.planner_item_completion({"submissions": {"missing": True}}),
            (False, "missing"),
        )

    def test_completed_peer_review_uses_its_own_workflow_state(self):
        for submissions in (False, True, None, {}, {"missing": True}):
            with self.subTest(submissions=submissions):
                item = fetch_canvas.planner_item_to_output({
                    "course_id": 1,
                    "plannable_id": 542480,
                    "plannable_type": "assessment_request",
                    "plannable_date": "2026-10-12T12:00:00Z",
                    "plannable": {"title": "课程互评", "workflow_state": "completed"},
                    "submissions": submissions,
                })
                self.assertTrue(item["completed"])
                self.assertEqual(item["completion_state"], "peer_review_completed")
                self.assertEqual(item["id"], "assessment_request:542480")

    def test_assigned_peer_review_stays_open(self):
        for workflow_state in ("assigned", "", None):
            with self.subTest(workflow_state=workflow_state):
                self.assertEqual(fetch_canvas.planner_item_completion({
                    "plannable_type": "assessment_request",
                    "plannable": {"workflow_state": workflow_state},
                    "submissions": False,
                }), (False, "unsubmitted"))

    def test_peer_review_completion_preserves_planner_override(self):
        self.assertEqual(fetch_canvas.planner_item_completion({
            "plannable_type": "assessment_request",
            "plannable": {"workflow_state": "completed"},
            "planner_override": {"marked_complete": True},
        }), (True, "planner_marked_complete"))

    def test_object_workflow_state_does_not_complete_other_planner_types(self):
        for item_type in ("assignment", "quiz", "discussion_topic", "planner_note", "peer_review_sub_assignment"):
            with self.subTest(item_type=item_type):
                self.assertEqual(fetch_canvas.planner_item_completion({
                    "plannable_type": item_type,
                    "plannable": {"workflow_state": "completed"},
                    "submissions": False,
                }), (False, "unsubmitted"))

    def test_peer_review_handles_missing_or_invalid_plannable(self):
        for plannable in (None, [], "invalid"):
            with self.subTest(plannable=plannable):
                self.assertEqual(fetch_canvas.planner_item_completion({
                    "plannable_type": "assessment_request",
                    "plannable": plannable,
                }), (False, "unsubmitted"))

    def test_planner_item_normalizes_quiz(self):
        item = fetch_canvas.planner_item_to_output({
            "course_id": 1,
            "plannable_id": 9,
            "plannable_type": "quiz",
            "plannable_date": "2026-09-20T12:00:00Z",
            "plannable": {"title": "章节测验", "assignment_id": 8},
            "submissions": {"graded": True},
            "html_url": "/courses/1/quizzes/9",
        })
        self.assertEqual(item["title"], "章节测验")
        self.assertEqual(item["type_label"], "测验")
        self.assertEqual(item["assignment_id"], 8)
        self.assertTrue(item["completed"])
        self.assertTrue(item["html_url"].endswith("/courses/1/quizzes/9"))

    def test_reminders_are_flat_stable_and_plain_text(self):
        feed = fetch_canvas.build_reminders_data({
            "generated_at": "2026-09-19T08:00:00+08:00",
            "timezone_offset": "+08:00",
            "courses": [{
                "id": 1,
                "name": "神经工程",
                "assignments": [{
                    "id": 2,
                    "title": "实验报告",
                    "item_type": "assignment",
                    "type_label": "作业",
                    "due_at": "2026-09-21T20:00:00+08:00",
                    "completed": False,
                    "html_url": "https://canvas.example/courses/1/assignments/2",
                    "description": "<p>完成<strong>第一章</strong></p>",
                }],
            }],
        })
        reminder = feed["items"][0]
        self.assertEqual(reminder["uid"], "canvas:1:assignment:2")
        self.assertEqual(reminder["due_at"], "2026年09月21日 20:00")
        self.assertEqual(reminder["remind_at"], "2026年09月20日 20:00")
        self.assertIn("完成 第一章", reminder["notes"])
        self.assertNotIn("<p>", reminder["notes"])

    def test_reminders_skip_items_without_due_date(self):
        feed = fetch_canvas.build_reminders_data({
            "courses": [{
                "id": 1,
                "name": "神经工程",
                "assignments": [{"id": 2, "title": "阅读材料", "due_at": None}],
            }],
        })
        self.assertEqual(feed["items"], [])

    def test_reminders_skip_past_due_items(self):
        feed = fetch_canvas.build_reminders_data({
            "generated_at": "2026-09-19T17:00:00+08:00",
            "courses": [{
                "id": 1,
                "name": "神经工程",
                "assignments": [{
                    "id": 2,
                    "title": "逾期作业",
                    "due_at": "2026-09-18T20:00:00+08:00",
                }],
            }],
        })
        self.assertEqual(feed["items"], [])

    def test_inline_json_cannot_close_script(self):
        encoded = fetch_canvas.json_for_html_script({"name": "</script><script>alert(1)</script>"})
        self.assertNotIn("</script>", encoded)
        self.assertEqual(json.loads(encoded)["name"], "</script><script>alert(1)</script>")


if __name__ == "__main__":
    unittest.main()
