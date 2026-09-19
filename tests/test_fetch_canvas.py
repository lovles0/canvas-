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

    def test_inline_json_cannot_close_script(self):
        encoded = fetch_canvas.json_for_html_script({"name": "</script><script>alert(1)</script>"})
        self.assertNotIn("</script>", encoded)
        self.assertEqual(json.loads(encoded)["name"], "</script><script>alert(1)</script>")


if __name__ == "__main__":
    unittest.main()
