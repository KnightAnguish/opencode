import { describe, expect, test } from "bun:test"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { createAcpFixture, expectOk, initialize, newSession, toolCallStream } from "./subprocess"

const command = "Start-Sleep -Milliseconds 800; Write-Output BG-OK; exit 3"

// The first completion starts a background shell; the follow-up ends that turn. The wake
// completion is only requested after the background shell reports BG-OK.
function backgroundModel(request: unknown) {
  const text = JSON.stringify(request)
  if (text.includes("BG-OK")) return "WAKE-DONE"
  if (text.includes('"role":"tool"')) return "FIRST-DONE"
  return toolCallStream("call_bg", "shell", { command, background: true })
}

describe("acp background work subprocess", () => {
  test(
    "keeps the prompt open until a background shell and the reply it wakes finish",
    async () => {
      await using fixture = await createAcpFixture({ respond: backgroundModel, config: { permission: "allow" } })
      const acp = fixture.spawn()
      await initialize(acp)
      const session = await newSession(acp, fixture.home)

      const started = Date.now()
      const result = expectOk(
        await acp.request<PromptResponse>("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "run the command in the background" }],
        }),
      )
      const elapsed = Date.now() - started

      expect(result.stopReason).toBe("end_turn")
      expect(elapsed).toBeGreaterThanOrEqual(700)
      expect(fixture.llm.requests.length).toBeGreaterThanOrEqual(3)
      const notifications = JSON.stringify(acp.messages.filter((message) => message.method === "session/update"))
      expect(notifications).toContain("Background job running")
      expect(notifications).toContain("Exit code: 3")
      expect(notifications).toContain("WAKE-DONE")
    },
    30_000,
  )
})
