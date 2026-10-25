/**
 * History sanitizer — a rescue seam for a session whose durable log holds
 * content the target wire protocol cannot represent.
 *
 * ## The gap this closes (dsh discussion #7065)
 *
 * A session's durable history is protocol-independent; a provider's wire format
 * is not. When a stored message carries a block the adapter cannot serialize,
 * `dsh-llm-deepseek`'s Messages serializer throws
 * `UNSUPPORTED_CONTENT` ("DeepSeek Messages cannot represent user/tool-result
 * content reasoning") for **every** later request of that session, because the
 * offending block sits in the log and the UI offers no way to edit it. One
 * stored block therefore makes a session permanently unusable on that route.
 *
 * The producer side is already fixed for the reported case
 * (`subagent` settlement notices became text-only in 0.1.6-alpha.1,
 * commit 29debb8b24) — but logs written before that release keep the block
 * forever, and the serializer's user-content vocabulary (`text`, `image`) is
 * narrower than the durable one for any producer, not just that one.
 *
 * ## What this plugin does
 *
 * It sanitizes the request *between* the harness and its adapter, on the public
 * `llm/stream` waterfall:
 *
 * - scoped roles' content (default: `user` and `tool` — the two roles a request
 *   receives content in) is filtered down to a vocabulary the route can
 *   represent;
 * - nested container content is filtered the same way, whatever the container's
 *   tag: the serializer walks it, so a poison block there fails the request
 *   identically, and the block vocabulary is merge-extensible;
 * - only when something is actually removed is the request re-dispatched, as a
 *   **new** object, through `ctx.llm.stream()` — never by mutating the request
 *   the loop assembled, which arrives deep-frozen and is the durable log's
 *   derived image;
 * - a healthy request takes the identity path: `next()` is called with the
 *   original object and nothing is copied, scanned twice, or re-dispatched.
 *
 * ## Why the rewrite is a re-dispatch, not an in-place edit
 *
 * `llm/stream` is a waterfall, but the last argument is the innermost `next`,
 * and cordis closes over the listener's own argument list: `next` takes **no**
 * parameters, so a listener cannot substitute the options object for the rest
 * of the chain. A deep-frozen loop request rejects mutation outright. A fresh
 * dispatch is therefore the only way to change what the adapter receives, and
 * this plugin registers with `prepend: true` so that every other `llm/stream`
 * listener sees exactly one dispatch per proposed request — the one that is
 * actually sent. (The consequence, stated plainly: when a rewrite fires, the
 * original object never reaches the inner listeners, and `dsh-agent-loop`'s
 * request-reconstruction invariant — which only inspects requests carrying the
 * loop's process-local marker — does not inspect the sanitized copy. The
 * rewrite is a deliberate transform of a request that could not have been sent
 * at all; it is logged, and it is bounded by `warnLimit`.)
 *
 * ## Why assistant content is out of scope by default
 *
 * Assistant `reasoning` blocks are **representable** on both DeepSeek protocols
 * (they serialize as `thinking`/`reasoning_content` and are required for
 * chain-of-thought passback — see discussion #739). Stripping them would trade
 * one broken session for a subtler one, so the default scope is user content
 * only.
 *
 * @module @argszero/cordis-plugin-history-sanitizer
 */
import z from '@deepseek-ai/schemastery';
/**
 * Block types this plugin knows to be containers, which are never removed.
 *
 * The walk does **not** consult this list: it descends into any block carrying a
 * nested block array, because the block vocabulary is merge-extensible and a
 * walk that names tags is how it goes stale. The list governs one decision —
 * allowlist mode must not drop a container, or a tool result becomes an empty
 * message and the request fails on the other side instead.
 */
const CONTAINER_TYPES = ['tool-result'];
/** Maximum nesting depth traversed inside container content. */
const MAX_DEPTH = 8;
/**
 * The nested block list a container block carries, or `undefined` for a leaf.
 *
 * Read structurally rather than through a typed member: the union of block types
 * is open, and only some members declare `content`.
 */
function containerContent(block) {
    const nested = block.content;
    return Array.isArray(nested) ? nested : undefined;
}
/** The plugin name used by the mount patch. */
export const name = 'history-sanitizer';
/** This plugin dispatches through `ctx.llm.stream()` and injects its service. */
export const inject = ['llm'];
/** Fill every default so the filter can be driven without Cordis. */
export function resolveConfig(config = {}) {
    return {
        stripTypes: config.stripTypes ?? ['reasoning', 'tool-call'],
        keepTypes: config.keepTypes,
        roles: config.roles ?? ['user', 'tool'],
        emptyPlaceholder: config.emptyPlaceholder ?? '(content removed by history-sanitizer)',
        warnLimit: config.warnLimit ?? 5,
        observeOnly: config.observeOnly ?? false,
    };
}
export const Config = z.object({
    stripTypes: z.array(z.string()).default(['reasoning', 'tool-call']),
    keepTypes: z.array(z.string()),
    roles: z.array(z.union(['user', 'assistant', 'system', 'tool'])).default(['user', 'tool']),
    emptyPlaceholder: z.string().default('(content removed by history-sanitizer)'),
    warnLimit: z.number().step(1).min(0).default(5),
    observeOnly: z.boolean().default(false),
});
/**
 * Whether one block type is removed under the resolved policy.
 *
 * `tool-result` is a container: it is never removed and its content is filtered
 * instead, so a tool result's text reaches the model even in allowlist mode.
 *
 * @param type - the block's `type` tag.
 * @param config - resolved configuration.
 * @returns whether the block is removed.
 */
export function isRemoved(type, config) {
    if (CONTAINER_TYPES.includes(type))
        return false;
    if (config.keepTypes !== undefined)
        return !config.keepTypes.includes(type);
    return config.stripTypes.includes(type);
}
/** Filter one block list, returning `undefined` when nothing was removed. */
function filterBlocks(blocks, config, removed, depth) {
    let changed = false;
    const kept = [];
    for (const block of blocks) {
        const nested = containerContent(block);
        if (nested !== undefined && depth < MAX_DEPTH) {
            // The policy still decides whether the container itself survives; the walk
            // only decides what its content is filtered down to. Allowlist mode must
            // keep removing a type it does not list, container or not.
            if (isRemoved(block.type, config)) {
                removed[block.type] = (removed[block.type] ?? 0) + 1;
                changed = true;
                continue;
            }
            const filtered = filterBlocks(nested, config, removed, depth + 1);
            if (filtered === undefined) {
                kept.push(block);
            }
            else {
                changed = true;
                kept.push({ ...block, content: filtered });
            }
            continue;
        }
        if (isRemoved(block.type, config)) {
            removed[block.type] = (removed[block.type] ?? 0) + 1;
            changed = true;
            continue;
        }
        kept.push(block);
    }
    return changed ? kept : undefined;
}
/**
 * Sanitize one request's messages under the resolved policy.
 *
 * Pure and identity-preserving: an untouched message is returned as the same
 * object, and a request with nothing to strip yields `undefined` (the caller
 * then takes its fast path). Tool-result content is traversed, because the
 * DeepSeek user-content serializer walks it and fails on the same block types
 * there.
 *
 * @param messages - the request's message list.
 * @param config - resolved configuration.
 * @returns the outcome, or `undefined` when no message needed a rewrite.
 */
export function sanitizeMessages(messages, config) {
    const removed = {};
    let rewritten = 0;
    let touched = false;
    const next = messages.map((message) => {
        if (!config.roles.includes(message.role))
            return message;
        const content = filterBlocks(message.content, config, removed, 0);
        if (content === undefined)
            return message;
        touched = true;
        rewritten += 1;
        const placeholder = content.length > 0
            ? content
            : [{ type: 'text', text: config.emptyPlaceholder }];
        return { ...message, content: placeholder };
    });
    if (!touched)
        return undefined;
    return { messages: next, removed, messagesRewritten: rewritten };
}
/** Render one outcome as a single bounded line. */
export function describeOutcome(outcome) {
    const counts = Object.entries(outcome.removed)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([type, count]) => `${type}×${count}`)
        .join(', ');
    return `${counts} removed from ${outcome.messagesRewritten} message(s)`;
}
/**
 * Register the sanitizer on the `llm/stream` waterfall.
 *
 * @param ctx - Cordis context carrying the `llm` service.
 * @param config - mount configuration.
 */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    // Requests this plugin dispatched itself. Membership is what stops the guard
    // from re-entering: the rewritten request is registered before it is sent, so
    // the listener recognizes it on the way back through the waterfall.
    const dispatched = new WeakSet();
    let warned = 0;
    const report = (line) => {
        if (resolved.warnLimit <= 0 || warned >= resolved.warnLimit)
            return;
        warned += 1;
        ctx.logger.warn(`history-sanitizer: ${line}`);
    };
    ctx.on('llm/stream', (options, next) => {
        if (dispatched.has(options))
            return next();
        const outcome = sanitizeMessages(options.messages, resolved);
        if (outcome?.messages === undefined)
            return next();
        if (resolved.observeOnly) {
            report(`${describeOutcome(outcome)} — observeOnly, request left unchanged`);
            return next();
        }
        report(`${describeOutcome(outcome)} — request re-dispatched`);
        const replacement = { ...options, messages: outcome.messages };
        dispatched.add(replacement);
        return ctx.llm.stream(replacement);
    }, { prepend: true });
}
