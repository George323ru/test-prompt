import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def read_frontend(name: str) -> str:
    return (FRONTEND / name).read_text(encoding="utf-8")


class FrontendUxContractTests(unittest.TestCase):
    def test_pages_use_shared_tabbed_navigation_with_active_state(self):
        for page in ("index.html", "eval.html", "analyze.html"):
            with self.subTest(page=page):
                html = read_frontend(page)
                self.assertIn('class="app-nav"', html)
                self.assertIn('class="nav-link active"', html)
                self.assertIn('aria-current="page"', html)

    def test_eval_has_grouped_controls_and_run_summary(self):
        html = read_frontend("eval.html")

        for label in ("Промпт", "Выборка", "Настройки", "Запуск"):
            self.assertIn(label, html)

        self.assertIn('id="runSummary"', html)
        self.assertIn('id="runBanner"', html)
        self.assertIn('id="advancedOptions"', html)
        self.assertIn('data-preset="quick"', html)
        self.assertIn('data-preset="full"', html)
        self.assertIn('data-preset="judge"', html)

    def test_analyze_exposes_upload_validation_and_template_download(self):
        html = read_frontend("analyze.html")

        self.assertIn('id="csvTemplateBtn"', html)
        self.assertIn('id="uploadValidation"', html)
        self.assertRegex(html, r"query_id.*GigaChat", re.S)

    def test_result_rows_can_expand_into_details_panel(self):
        eval_js = read_frontend("eval.js")
        analyze_js = read_frontend("analyze.js")

        self.assertIn("showEvalDetails", eval_js)
        self.assertIn("showAnalyzeDetails", analyze_js)
        self.assertIn("detailsPanel", read_frontend("eval.html"))
        self.assertIn("detailsPanel", read_frontend("analyze.html"))

    def test_mobile_results_use_cards_instead_of_wide_table_only(self):
        css = read_frontend("style.css")

        self.assertIn(".result-card", css)
        self.assertIn(".table-card-list", css)
        self.assertNotIn("min-width: 760px", css)


if __name__ == "__main__":
    unittest.main()
