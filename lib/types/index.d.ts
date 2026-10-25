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
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
/**
 * Message roles this plugin can scope to.
 *
 * `user` and `tool` are the two roles a request receives *content* in — user
 * input, and whatever a tool returned — so they are the default scope. From
 * `0.2.1-rc.1` on a tool result is its own `role: 'tool'` message; before that
 * it arrived as a `tool-result` container inside a user message. Both shapes are
 * named here, because a scope that only knows one of them stops rescuing the
 * sessions most poisons arrive in while still reporting success.
 */
export type ScopedRole = 'user' | 'assistant' | 'system' | 'tool';
/**
 * The part of a message this filter reads: its scope role and its blocks.
 *
 * Structural on purpose. `GenerateOptions.messages` is `Message[]` on the 0.1.x
 * lines and `RequestMessage[]` (`Message | RequestUserInput`) from `0.2.1-rc.1`
 * on, and this filter must compile and behave on both without naming a type
 * that only one of them has.
 */
export interface WalkableMessage {
    readonly role: string;
    readonly content: readonly ContentBlock[];
}
/** Plugin configuration. */
export interface Config {
    /**
     * Block types removed from scoped content. Default `['reasoning', 'tool-call']`
     * — the two a durable user message can carry and no supported DeepSeek
     * protocol can represent. Ignored when `keepTypes` is set.
     */
    stripTypes?: string[];
    /**
     * Allowlist mode: when present, every scoped block type **not** listed is
     * removed. Use it when the failing block type is not known ahead of time
     * (e.g. a block contributed by another plugin); the known-safe default keeps
     * the conservative denylist instead.
     */
    keepTypes?: string[];
    /**
     * Roles whose content is filtered. Default `['user', 'tool']` — the two roles
     * a request receives content in. From `0.2.1-rc.1` on a tool result is its own
     * `role: 'tool'` message, so a scope of `['user']` alone no longer covers it;
     * naming `roles` explicitly replaces the default. Do not add `assistant`
     * without reading the module note: assistant reasoning is representable and is
     * required for chain-of-thought passback.
     */
    roles?: ScopedRole[];
    /**
     * Text substituted for a scoped message whose content became empty after
     * filtering. A message with an empty content list is itself unrepresentable
     * on some routes, so the message is kept with this placeholder rather than
     * dropped or emitted empty.
     */
    emptyPlaceholder?: string;
    /** Bound on emitted warnings per plugin lifetime. `0` silences logging. Default `5`. */
    warnLimit?: number;
    /** Report what would be removed without rewriting the request. Default `false`. */
    observeOnly?: boolean;
}
/** Configuration with every default materialized. */
export interface ResolvedConfig {
    readonly stripTypes: readonly string[];
    readonly keepTypes: readonly string[] | undefined;
    readonly roles: readonly ScopedRole[];
    readonly emptyPlaceholder: string;
    readonly warnLimit: number;
    readonly observeOnly: boolean;
}
/** The plugin name used by the mount patch. */
export declare const name = "history-sanitizer";
/** This plugin dispatches through `ctx.llm.stream()` and injects its service. */
export declare const inject: string[];
/** Fill every default so the filter can be driven without Cordis. */
export declare function resolveConfig(config?: Config): ResolvedConfig;
export declare const Config: z<Config>;
/** One sanitize pass's account of what it did. */
export interface SanitizeOutcome<T extends WalkableMessage = Message> {
    /** The rewritten message list; `undefined` when no message needed a rewrite. */
    readonly messages?: T[];
    /** Removed block counts, keyed by block type. */
    readonly removed: Record<string, number>;
    /** How many messages were rebuilt. */
    readonly messagesRewritten: number;
}
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
export declare function isRemoved(type: string, config: ResolvedConfig): boolean;
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
export declare function sanitizeMessages<T extends WalkableMessage>(messages: readonly T[], config: ResolvedConfig): SanitizeOutcome<T> | undefined;
/** Render one outcome as a single bounded line. */
export declare function describeOutcome<T extends WalkableMessage>(outcome: SanitizeOutcome<T>): string;
/**
 * Register the sanitizer on the `llm/stream` waterfall.
 *
 * @param ctx - Cordis context carrying the `llm` service.
 * @param config - mount configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
