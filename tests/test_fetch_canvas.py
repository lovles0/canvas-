import json
import unittest

import fetch_canvas


class FetchCanvasTests(unittest.TestCase):
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
