/**
 * Fixture extension whose server() declares a mutable-output hook key that is
 * unsupported under process isolation (design §3.1 / T5.0 item 3).
 */
export default {
  id: "test.fixture-ext",
  async activate() {
    return {}
  },
  async server() {
    return {
      "chat.message": async () => {},
      tool: {},
    }
  },
}
