import unittest

import main


class ChatHistoryRestoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main.sessions.clear()

    async def test_restore_history_replaces_current_session_history(self):
        history = [
            {"role": "user", "content": "Первое сообщение"},
            {"role": "assistant", "content": "Первый ответ"},
        ]

        result = await main.restore_history_endpoint(main.HistoryRestoreRequest(history=history), session_id="ux-test")

        self.assertEqual(result["history"], history)
        self.assertEqual(main.sessions["ux-test"]["history"], history)

    async def test_restore_history_rejects_unknown_roles(self):
        with self.assertRaises(Exception):
            await main.restore_history_endpoint(
                main.HistoryRestoreRequest(history=[{"role": "system", "content": "x"}]),
                session_id="ux-test",
            )


if __name__ == "__main__":
    unittest.main()
