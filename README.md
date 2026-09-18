# @argszero/cordis-plugin-history-sanitizer

Rescue a session whose **durable log** holds content the target wire protocol
cannot represent.

Source: [deepseek-harness discussion #7065](https://github.com/deepseek-ai/deepseek-harness/discussions/7065).

## The gap

A session's durable history is protocol-independent; a provider's wire format is
not. `dsh-llm-deepseek`'s Messages serializer accepts only `text` and `image`
content for user and tool-result messages
(`packages/llm/llm-deepseek/src/messages/serialize.ts`) — anything else throws
`UNSUPPORTED_CONTENT`:

```
DeepSeek Messages cannot represent user/tool-result content reasoning
```

The offending block sits in the durable log, and no UI can edit it, so **one
stored block makes the session permanently unusable** on that route — every
later request of that session fails before a single byte reaches the wire.
`UNSUPPORTED_CONTENT` is not in the retryable set, so it fails fast, forever.

The producer side of the reported case is already fixed (subagent settlement
notices became text-only in `0.1.6-alpha.1`, commit `29debb8b24`), but:

- logs written before that release keep the block forever, and
- the serializer's user-content vocabulary is narrower than the durable one for
  **any** producer, not just that one.

Note the cross-protocol asymmetry: the sibling chat-completions serializer
silently *drops* the same blocks instead of failing. The default protocol
changed to `messages`, which turned a silent drop into a hard failure.

## What it does

Mounted on the public `llm/stream` waterfall, the plugin filters scoped message
content down to a representable vocabulary **before** the adapter serializes it:

- scoped roles' content (default: `user`, which covers tool results);
- nested `tool-result` content, filtered the same way (the serializer walks it,
  so a poison block there fails the request identically);
- only when something is actually removed is the request re-dispatched, as a
  **new** object, through `ctx.llm.stream()`;
- a healthy request takes the identity path: `next()` receives the original
  object, nothing is copied, scanned twice, or re-dispatched.

Assistant content is out of scope by default. Assistant `reasoning` blocks are
*representable* on both DeepSeek protocols (they serialize as
`thinking`/`reasoning_content` and are required for chain-of-thought passback),
so stripping them would trade one broken session for a subtler one.

## Install

```sh
npm install @argszero/cordis-plugin-history-sanitizer
```

It is a normal dsh bundle: the package ships a `cordis.patch.yml`, so mounting
it is a config entry.

## Configure

All options are optional.

| option | default | meaning |
| --- | --- | --- |
| `stripTypes` | `['reasoning', 'tool-call']` | block types removed from scoped content; ignored when `keepTypes` is set |
| `keepTypes` | — | allowlist mode: every scoped block type **not** listed is removed. Use when the failing block type is not known ahead of time (e.g. contributed by another plugin) |
| `roles` | `['user']` | roles whose content is filtered. `user` covers tool results |
| `emptyPlaceholder` | `(content removed by history-sanitizer)` | text substituted when filtering empties a message — an empty content list is itself unrepresentable on some routes |
| `warnLimit` | `5` | bound on emitted warnings per plugin lifetime; `0` silences logging |
| `observeOnly` | `false` | report what *would* be removed without rewriting the request |

### Why the default denylist is only two types

The Messages serializer accepts exactly two block types in user and tool-result
content, and names the offender when it refuses:

```js
if (block.type === 'text')  return block.text ? [{ type: 'text', text: block.text }] : []
if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
```

So `file` is unrepresentable there too — and the default **keeps** it. The line
is not "unrepresentable" but "can this legitimately be user content":

- `reasoning` and `tool-call` are assistant vocabulary. In a user message they
  are a producer bug (exactly what #7065 reports), so removing them loses
  nothing.
- `file` and `image` are legitimate user content. Removing an attached document
  to make a request sendable would silently discard something real, so that
  decision belongs to the operator, through allowlist mode.

| configuration | user `reasoning` | user `file` |
| --- | --- | --- |
| default (denylist) | removed | kept — request still fails |
| `keepTypes: [text, image]` | removed | removed |

Example — the failing block type is unknown, so allowlist what the route can
represent:

```yaml
plugins:
  '@argszero/cordis-plugin-history-sanitizer':
    keepTypes: [text, image]
```

## Why a re-dispatch and not an in-place edit

`llm/stream` is a waterfall, but cordis closes over the listener's own argument
list: the `next` it passes takes **no** parameters, so a listener cannot
substitute the options object for the rest of the chain. A loop-assembled
request is also deep-frozen, so mutation throws. A fresh dispatch is therefore
the only way to change what the adapter receives. The plugin registers with
`prepend: true` so every other `llm/stream` listener sees exactly one dispatch
per proposed request — the one actually sent.

## Peer lines

The runtime surface is the public `llm/stream` waterfall plus the `Message` /
`ContentBlock` types, which are stable across the prerelease lines. Each
declared line was installed and run once, from this package's **packed
tarball** into a fresh tree (a range is a claim; a claim is only as good as the
last time someone ran the code against it):

| declared line | fresh install of the line | suite against that line |
| --- | --- | --- |
| `0.1.2-rc.1` | ok | 19 passed, 0 failed (3 self-skipped) |
| `0.1.3-alpha.2` | ok | 19 passed, 0 failed (3 self-skipped) |
| `0.1.5-rc.2` | ok | 19 passed, 0 failed (3 self-skipped) |
| `0.1.6-alpha.2` | ok | 22 passed, 0 failed |
| `0.1.5-alpha.1`, `0.1.5-alpha.2`, `0.1.5-rc.1`, `0.1.6-alpha.1` | **refused by npm** | not reached |

The four "refused" lines are **not** a statement about this plugin: a bare
install of the line's own packages, with no plugin in the tree at all,
reproduces the identical `ERESOLVE`:

```
Could not resolve dependency:
peer @deepseek-ai/dsh-llm@"^0.1.6-alpha.1" from @deepseek-ai/dsh-llm-deepseek@0.1.6-alpha.1
  node_modules/@deepseek-ai/dsh-llm-deepseek
Could not resolve dependency:
peer @deepseek-ai/dsh-llm@"^0.1.6-alpha.2" from @deepseek-ai/dsh-fs@0.1.6-alpha.2
  peer @deepseek-ai/dsh-fs@"^0.1.6-alpha.1" from @deepseek-ai/dsh-llm-deepseek@0.1.6-alpha.1
```

`dsh-llm-deepseek@X` peer-requires `dsh-fs@^X`; a `^` range whose comparator
carries a prerelease admits the *next prerelease of the same tuple*, so npm
resolves `dsh-fs` one line ahead — and that `dsh-fs` peer-requires the next
line's `dsh-llm`. Every pinned non-latest prerelease line is therefore
un-installable in a fresh tree, for everyone, whatever they are installing.
These lines are still declared, because the range describes the plugin's
**runtime surface**, and that surface is identical on them.

Three of the four claims in `test/deepseek.spec.mjs` (the end-to-end half that
drives a real `dsh-llm-deepseek` adapter against a stubbed global `fetch`)
assert on `UNSUPPORTED_CONTENT`, which only exists on lines that ship the
Messages protocol (`0.1.6-alpha.1`+). Those three detect at runtime whether the
installed adapter speaks Messages and self-skip on older lines rather than
asserting a failure that cannot occur there.

The range string is deliberately written as an explicit set of prerelease
tuples: a plain `^0.1.2-rc.1` does **not** admit `0.1.3-alpha.2` or
`0.1.6-alpha.2` under semver prerelease rules, so a caret range would silently
reject the very lines this plugin is tested on.

## The core fix this plugin does not replace

This is a **read-boundary workaround**, and it is honest about that: the
sanitizer cannot restore the dropped block, it only lets the session be used
again. The real remedy belongs where the block is read back — the durable log's
reader should not re-emit content the target protocol cannot represent, or the
serializer should degrade the same way its chat-completions sibling does
(drop + warn) instead of throwing. Until then, a session with a poison block has
exactly two exits: delete the session, or mount this.

A second, narrower core change is also owed and is not covered here:
`packages/llm/llm-deepseek/src/chat-completions/serialize.ts` emits
`reasoning_content` conditionally on non-empty reasoning, which is a live bug on
its own (see discussion #739).

## Development

```sh
npm install && npm test    # `pretest` builds lib/ first
```

The repository tracks no build output (`lib/` is gitignored); `npm test` compiles
it, and so does `npm publish` through `prepublishOnly`. Test layout:

- `test/sanitize.spec.mjs` — the pure filter: vocabulary, scope, nesting, identity.
- `test/cordis.spec.mjs` — a real `@deepseek-ai/cordis` context and a real
  `llm/stream` waterfall: one dispatch per proposed request, no mutation of a
  frozen request, no copy on the healthy path.
- `test/deepseek.spec.mjs` — end to end with a real `@deepseek-ai/dsh-llm-deepseek`
  adapter and a stubbed global `fetch`: the stored notice dies with zero HTTP
  calls, and reaches the wire sanitized once the plugin is mounted.

## License

MIT
