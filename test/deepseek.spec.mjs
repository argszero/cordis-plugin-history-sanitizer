/**
 * End-to-end evidence for discussion #7065, against the **published**
 * `@deepseek-ai/dsh-llm-deepseek` adapter (0.1.6-alpha.2) with the real
 * serializer and a stubbed global `fetch`.
 *
 * The reporter's claim, split into the three parts a reader can check:
 *  1. a stored user message carrying a reasoning block fails every request on
 *     the Messages protocol — before any HTTP call is made;
 *  2. the same log is silently accepted by the sibling chat-completions
 *     serializer, so the failure is a property of the protocol, not the log;
 *  3. with this plugin mounted, the request reaches the wire and carries no
 *     unrepresentable block.
 *
 * The adapter is mounted exactly as a profile mounts it (`inject: ['llm']`), so
 * this exercises the same seam the plugin patches in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as deepseek from '@deepseek-ai/dsh-llm-deepseek'
import * as plugin from '../lib/index.js'

process.env.DEEPSEEK_API_KEY = 'discussion-7065-fixture'

const MODEL = { id: 'probe-model', name: 'Probe', contextWindow: 100_000, maxTokens: 1_000 }

/** A settlement notice shaped exactly as a pre-0.1.6-alpha.1 build stored one. */
const storedNotice = () => createUserMessage({
  content: [
    { type: 'text', text: 'Its closing message:' },
    { type: 'reasoning', text: 'child thinking' },
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  ],
  source: { kind: 'subagent-settled', childId: 'child-1', form: 'notice' },
})

const SSE_MESSAGES = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"probe-model","usage":{"input_tokens":1,"output_tokens":1}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const SSE_CHAT = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

/** Mount the runtime, the real DeepSeek adapter and (optionally) this plugin. */
async function mount({ protocol, withPlugin }) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(
    { name: deepseek.name, inject: deepseek.inject, apply: deepseek.apply },
    { protocol, baseURL: 'https://probe.invalid', models: [MODEL], streamIdleTimeoutMs: 3_000 },
  )
  if (withPlugin) await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {})

  const requests = []
  const sse = protocol === 'messages' ? SSE_MESSAGES : SSE_CHAT
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { ctx, requests }
}

/** A session state with nothing the wire cannot represent. */
const healthy = () => createUserMessage({
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'plugin', plugin: 'test' },
})

/** Drive one request and return the terminal chunk's failure code, if any. */
async function drive(ctx, messages) {
  let code
  for await (const chunk of ctx.llm.stream({ provider: 'deepseek-official', model: MODEL.id, messages })) {
    if (chunk.type === 'finish') code = chunk.reason?.failure?.code ?? chunk.reason?.kind
  }
  return code
}

/**
 * Does the adapter installed at this dsh line actually speak the Messages
 * protocol? The `protocol` config field and the Messages implementation landed
 * in 0.1.6-alpha.1; before it the DeepSeek adapter always spoke
 * chat-completions, so the failure #7065 reports cannot occur on those lines.
 * Detected at runtime (the older config schema ignores the unknown key) rather
 * than assumed from a version number.
 */
const HAS_MESSAGES = await (async () => {
  const { ctx, requests } = await mount({ protocol: 'messages', withPlugin: false })
  await drive(ctx, [healthy()])
  return requests[0]?.url.endsWith('/messages') === true
})()

/** Skip note for the three claims that require the Messages protocol. */
const MESSAGES_ONLY = HAS_MESSAGES
  ? false
  : 'this dsh line predates the Messages protocol, so its DeepSeek adapter cannot fail this way'

test('#7065 (a): on Messages, one stored reasoning block fails the whole request before any HTTP call', { skip: MESSAGES_ONLY }, async () => {
  const { ctx, requests } = await mount({ protocol: 'messages', withPlugin: false })
  const code = await drive(ctx, [storedNotice()])
  assert.equal(code, 'UNSUPPORTED_CONTENT')
  assert.equal(requests.length, 0, 'the serializer threw before the transport was reached')
})

test('#7065 (b): the sibling chat-completions serializer accepts the same log, silently dropping the block', async () => {
  const { ctx, requests } = await mount({ protocol: 'chat-completions', withPlugin: false })
  const code = await drive(ctx, [storedNotice()])
  assert.notEqual(code, 'UNSUPPORTED_CONTENT', 'no unsupported-content failure on this protocol')
  assert.equal(requests.length, 1, 'the request was actually sent')
  const serialized = JSON.stringify(requests[0].body)
  assert.ok(serialized.includes('Its closing message:'), 'the representable text survived')
  assert.ok(!serialized.includes('child thinking'), 'the reasoning text was dropped, not sent')
  assert.ok(!serialized.includes('call-1'), 'and so was the misplaced tool call')
})

test('#7065 (c): with the plugin mounted the same stored notice reaches the wire, sanitized', { skip: MESSAGES_ONLY }, async () => {
  const { ctx, requests } = await mount({ protocol: 'messages', withPlugin: true })
  const code = await drive(ctx, [storedNotice()])

  assert.equal(requests.length, 1, 'exactly one provider call')
  assert.match(requests[0].url, /\/messages$/)
  const serialized = JSON.stringify(requests[0].body)
  assert.ok(serialized.includes('Its closing message:'), 'the notice text still reaches the model')
  assert.ok(!serialized.includes('child thinking'), 'the reasoning text is gone')
  assert.ok(!serialized.includes('tool_use'), 'and so is the misplaced tool call')
  assert.notEqual(code, 'UNSUPPORTED_CONTENT', 'the request is no longer rejected for unrepresentable content')
})

test('a healthy session is not touched by the plugin', { skip: MESSAGES_ONLY }, async () => {
  const { ctx, requests } = await mount({ protocol: 'messages', withPlugin: true })
  const code = await drive(ctx, [healthy()])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  assert.notEqual(code, 'UNSUPPORTED_CONTENT')
})
