/**
 * Unit tests for the filter itself: vocabulary, scope, nesting, identity.
 *
 * The filter is pure, so these tests drive it directly with plain message
 * objects and never mount a Cordis context.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemoved, resolveConfig, sanitizeMessages } from '../lib/index.js'

const text = (value) => ({ type: 'text', text: value })
const reasoning = (value) => ({ type: 'reasoning', text: value })
const toolCall = (id = 'call-1') => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })
const toolResult = (content, toolCallId = 'call-1') => ({ type: 'tool-result', toolCallId, content })

const message = (role, content, extra = {}) => ({
  id: `m-${role}-${Math.abs(content.length)}`,
  role,
  content,
  source: { kind: 'plugin', plugin: 'test' },
  ...extra,
})

test('defaults remove the two blocks no DeepSeek protocol can represent in user content', () => {
  const config = resolveConfig()
  const messages = [
    message('user', [text('Its closing message:'), reasoning('child thinking'), toolCall(), text('done')]),
  ]
  const outcome = sanitizeMessages(messages, config)
  assert.ok(outcome, 'a poisoned message produces an outcome')
  assert.deepEqual(outcome.removed, { reasoning: 1, 'tool-call': 1 })
  assert.equal(outcome.messagesRewritten, 1)
  assert.deepEqual(outcome.messages[0].content, [text('Its closing message:'), text('done')])
})

test('a message with nothing to remove yields no outcome, and untouched messages keep their identity', () => {
  const config = resolveConfig()
  assert.equal(sanitizeMessages([message('user', [text('hello')])], config), undefined)
  const clean = message('user', [text('hello')])
  const poisoned = message('user', [reasoning('x')])
  const outcome = sanitizeMessages([clean, poisoned], config)
  assert.ok(outcome)
  assert.equal(outcome.messages[0], clean, 'an untouched message is the same object')
  assert.notEqual(outcome.messages[1], poisoned, 'a rewritten message is a new object')
})

test('assistant content is out of scope by default (its reasoning is representable and required for passback)', () => {
  const config = resolveConfig()
  const assistant = message('assistant', [reasoning('visible thinking'), toolCall()])
  assert.equal(sanitizeMessages([assistant], config), undefined)
})

test('nested tool-result content is filtered on the same terms as user content', () => {
  const config = resolveConfig()
  const messages = [
    message('user', [text('output:'), toolResult([text('file1 file2'), reasoning('inner'), toolCall('call-9')])]),
  ]
  const outcome = sanitizeMessages(messages, config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { reasoning: 1, 'tool-call': 1 })
  assert.deepEqual(outcome.messages[0].content[1].content, [text('file1 file2')])
})

test('a tool-result container is never removed, only traversed', () => {
  const config = resolveConfig({ keepTypes: ['text'] })
  assert.equal(isRemoved('tool-result', config), false)
  const messages = [message('user', [toolResult([text('kept')])])]
  assert.equal(sanitizeMessages(messages, config), undefined)
})

test('a `file` block is kept by default and only removed in allowlist mode', () => {
  // `file` is also unrepresentable on the DeepSeek Messages route, but unlike
  // `reasoning`/`tool-call` it is legitimate user content — an attached
  // document — so removing it by default would discard something real. The
  // denylist therefore covers only blocks that cannot be user content at all;
  // any other unrepresentable type is the operator's call, via allowlist mode.
  const file = { type: 'file', attachment: { attachmentId: 'att-1' }, filename: 'report.pdf' }
  const user = message('user', [file, text('summarize this')])

  assert.equal(sanitizeMessages([user], resolveConfig()), undefined, 'denylist keeps the attachment')

  const outcome = sanitizeMessages([user], resolveConfig({ keepTypes: ['text', 'image'] }))
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { file: 1 })
  assert.deepEqual(outcome.messages[0].content, [text('summarize this')])
})

test('allowlist mode removes every block type it does not list', () => {
  const config = resolveConfig({ keepTypes: ['text', 'image', 'file', 'tool-result'] })
  const messages = [message('user', [text('kept'), { type: 'plugin-block', payload: 1 }, reasoning('gone')])]
  const outcome = sanitizeMessages(messages, config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { 'plugin-block': 1, reasoning: 1 })
  assert.deepEqual(outcome.messages[0].content, [text('kept')])
})

test('roles widen the scope when configured', () => {
  const config = resolveConfig({ roles: ['user', 'assistant', 'system'] })
  const messages = [
    message('assistant', [reasoning('gone')]),
    message('system', [text('kept'), reasoning('gone')]),
  ]
  const outcome = sanitizeMessages(messages, config)
  assert.ok(outcome)
  assert.equal(outcome.messagesRewritten, 2)
  assert.deepEqual(outcome.messages[0].content, [text('(content removed by history-sanitizer)')])
  assert.deepEqual(outcome.messages[1].content, [text('kept')])
})

test('a message emptied by filtering keeps a placeholder instead of an empty content list', () => {
  const config = resolveConfig()
  const outcome = sanitizeMessages([message('user', [reasoning('only')])], config)
  assert.ok(outcome)
  assert.deepEqual(outcome.messages[0].content, [text('(content removed by history-sanitizer)')])
  const custom = resolveConfig({ emptyPlaceholder: '[removed]' })
  assert.deepEqual(sanitizeMessages([message('user', [reasoning('only')])], custom).messages[0].content, [text('[removed]')])
})

test('nesting deeper than the traversal bound is left alone rather than recursed without limit', () => {
  const config = resolveConfig()
  let deepest = [reasoning('deep')]
  for (let index = 0; index < 12; index += 1) deepest = [toolResult(deepest, `call-${index}`)]
  const outcome = sanitizeMessages([message('user', deepest)], config)
  assert.equal(outcome, undefined, 'beyond the bound the filter stops descending and finds nothing to remove')
})

test('shallow nesting is still reached, so the bound only trims the pathological case', () => {
  const config = resolveConfig()
  let nested = [reasoning('shallow')]
  for (let index = 0; index < 4; index += 1) nested = [toolResult(nested, `call-${index}`)]
  const outcome = sanitizeMessages([message('user', nested)], config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { reasoning: 1 })
})

test('tool results are in the default scope, as a container and as a tool message', () => {
  // The same poison, in the two shapes the same repository produces: a durable
  // user message holding a `tool-result` container (0.1.x lines), and a
  // first-class `role: 'tool'` message (0.2.1-rc.1 and on). A scope naming only
  // `user` reaches the first and silently misses the second.
  const config = resolveConfig()
  const asContainer = message('user', [toolResult([text('out'), reasoning('inner')])])
  const asMessage = message('tool', [text('out'), reasoning('inner')], { toolCallId: 'call-1' })
  const outcome = sanitizeMessages([asContainer, asMessage], config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { reasoning: 2 })
  assert.deepEqual(outcome.messages[0].content[0].content, [text('out')])
  assert.deepEqual(outcome.messages[1].content, [text('out')])
})

test('a scope of user alone leaves tool messages alone, which is why the default names both', () => {
  const narrow = resolveConfig({ roles: ['user'] })
  const tool = message('tool', [reasoning('inner')], { toolCallId: 'call-1' })
  assert.equal(sanitizeMessages([tool], narrow), undefined)
})

test('a container whose tag this plugin has never seen is still traversed', () => {
  // The block vocabulary is merge-extensible, so the walk reads structure: any
  // block carrying a nested block array is descended into. A tag list would go
  // stale exactly where a poison is most likely to hide.
  const config = resolveConfig()
  const future = { type: 'future-container', content: [text('kept'), reasoning('gone')] }
  const outcome = sanitizeMessages([message('user', [future])], config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { reasoning: 1 })
  assert.deepEqual(outcome.messages[0].content[0].content, [text('kept')])
})

test('allowlist mode still removes a container type it does not list', () => {
  const config = resolveConfig({ keepTypes: ['text'] })
  const future = { type: 'future-container', content: [text('inner')] }
  assert.equal(isRemoved('future-container', config), true)
  const outcome = sanitizeMessages([message('user', [future])], config)
  assert.ok(outcome)
  assert.deepEqual(outcome.removed, { 'future-container': 1 })
})
