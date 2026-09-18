/**
 * Wiring tests against a real Cordis context, a real `llm/stream` waterfall and
 * a real `dsh-llm` runtime with a stub adapter.
 *
 * What these prove, in the order the plugin depends on it:
 *  - the listener is reached by a real dispatch (the `inject` gate and the
 *    `prepend` placement both allow it);
 *  - when a rewrite fires, the adapter receives the sanitized request and every
 *    other listener sees exactly one dispatch;
 *  - the rewritten request is a new object, and the loop's frozen original is
 *    untouched;
 *  - the guard makes the re-dispatch terminate: one adapter call per request;
 *  - a healthy request is dispatched as the identical object (no copying).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const SCRIPT = [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]

class RecordingAdapter extends LlmAdapter {
  seen = []

  async * stream(options) {
    this.seen.push(options)
    yield * SCRIPT
  }
}

const poisoned = () => createUserMessage({
  content: [
    { type: 'text', text: 'Its closing message:' },
    { type: 'reasoning', text: 'child thinking' },
    { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
  ],
  source: { kind: 'plugin', plugin: 'test' },
})

const healthy = () => createUserMessage({
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'plugin', plugin: 'test' },
})

/** Mount the runtime, an outer observation listener, the plugin and an adapter. */
async function mount(config = {}, options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const warnings = []
  // `levels.default` must admit WARN: cordis drops a message whose severity is
  // below the exporter's level, and the root logger defaults to INFO.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'warn') warnings.push(message.args.map(String).join(' ')) },
  })
  const observed = []
  // Registered BEFORE the plugin, so it sits inside our listener's position in
  // the chain (the plugin prepends itself outermost) and observes exactly the
  // request that is finally dispatched.
  ctx.on('llm/stream', (options_, next) => {
    observed.push(options_)
    return next()
  })
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([options.provider ?? 'probe'], adapter)
  return { ctx, adapter, observed, warnings }
}

const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('a poisoned user message is rewritten before the adapter serializes it', async () => {
  const { ctx, adapter, observed } = await mount()
  const request = { provider: 'probe', model: 'm', messages: [poisoned()] }
  const chunks = await collect(ctx.llm.stream(request))

  assert.equal(adapter.seen.length, 1, 'exactly one adapter call — the guard terminated the re-dispatch')
  const dispatched = adapter.seen[0]
  const content = dispatched.messages[0].content
  assert.deepEqual(content, [{ type: 'text', text: 'Its closing message:' }], 'only the representable block survives')
  assert.equal(dispatched.messages[0].role, 'user', 'the message keeps its role')
  assert.equal(dispatched.messages[0].source.kind, 'plugin', 'and its source')
  assert.notEqual(dispatched, request, 'the adapter sees a rewritten request object')
  assert.equal(request.messages[0].content.length, 3, 'the original request is untouched')

  assert.equal(observed.length, 1, 'other listeners observe exactly one dispatch')
  assert.equal(observed[0].messages[0].content.length, 1, 'and it is the sanitized one')

  assert.deepEqual(chunks, SCRIPT, 'the consumer still receives the provider chunks')
})

test('the frozen loop-style request is never mutated', async () => {
  const { ctx, adapter } = await mount()
  const request = Object.freeze({
    provider: 'probe',
    model: 'm',
    messages: Object.freeze([poisoned()]),
  })
  await collect(ctx.llm.stream(request))
  assert.equal(adapter.seen.length, 1)
  assert.equal(request.messages[0].content.length, 3)
  assert.equal(adapter.seen[0].messages[0].content.length, 1)
})

test('a healthy request takes the identity path: same object, no copy, no extra dispatch', async () => {
  const { ctx, adapter, observed } = await mount()
  const request = { provider: 'probe', model: 'm', messages: [healthy()] }
  await collect(ctx.llm.stream(request))
  assert.equal(adapter.seen.length, 1)
  assert.equal(adapter.seen[0], request, 'the adapter receives the very same request object')
  assert.equal(observed[0], request)
})

test('observeOnly reports the removal and dispatches the request unchanged', async () => {
  const { ctx, adapter, warnings } = await mount({ observeOnly: true })
  const request = { provider: 'probe', model: 'm', messages: [poisoned()] }
  await collect(ctx.llm.stream(request))
  assert.equal(adapter.seen[0], request, 'nothing was rewritten')
  assert.equal(adapter.seen[0].messages[0].content.length, 3)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /reasoning×1, tool-call×1 removed from 1 message\(s\) — observeOnly/)
})

test('diagnostics name what was removed and are bounded by warnLimit', async () => {
  const { ctx, warnings } = await mount({ warnLimit: 2 })
  for (let index = 0; index < 4; index += 1) {
    await collect(ctx.llm.stream({ provider: 'probe', model: 'm', messages: [poisoned()] }))
  }
  assert.equal(warnings.length, 2, 'the bound holds')
  assert.match(warnings[0], /reasoning×1, tool-call×1 removed from 1 message\(s\) — request re-dispatched/)
})

test('warnLimit 0 silences diagnostics without changing behaviour', async () => {
  const { ctx, adapter, warnings } = await mount({ warnLimit: 0 })
  await collect(ctx.llm.stream({ provider: 'probe', model: 'm', messages: [poisoned()] }))
  assert.equal(warnings.length, 0)
  assert.equal(adapter.seen[0].messages[0].content.length, 1, 'the rewrite still happened')
})

test('a plugin block unknown to the adapter is removable through allowlist mode', async () => {
  const { ctx, adapter } = await mount({ keepTypes: ['text'] })
  const message = createUserMessage({
    content: [{ type: 'text', text: 'kept' }, { type: 'plugin-block', payload: 1 }],
    source: { kind: 'plugin', plugin: 'test' },
  })
  await collect(ctx.llm.stream({ provider: 'probe', model: 'm', messages: [message] }))
  assert.deepEqual(adapter.seen[0].messages[0].content, [{ type: 'text', text: 'kept' }])
})

test('defaults leave assistant reasoning alone so chain-of-thought passback still works', async () => {
  const { ctx, adapter } = await mount()
  const assistant = {
    id: 'a-1',
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'thinking' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
    source: { kind: 'model', provider: 'probe', model: 'm' },
  }
  const request = { provider: 'probe', model: 'm', messages: [healthy(), assistant] }
  await collect(ctx.llm.stream(request))
  assert.equal(adapter.seen[0], request)
  assert.equal(adapter.seen[0].messages[1].content.length, 2)
})
