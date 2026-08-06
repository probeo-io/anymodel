# Feature: OpenAI Responses Function Tools

## Outcome

Allow an Anymodel caller using the common chat-and-tools contract to run an
OpenAI reasoning model through the Responses API, execute function tools, and
continue the same tool loop without switching to a provider-specific SDK.

This feature is for provider compatibility. It does not change the common
Anymodel tool contract or require callers to understand OpenAI response-item
formats.

## Input contract

Extend `ChatCompletionRequest` with an optional normalized reasoning request:

```ts
reasoning?: { effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
```

The caller configures the effort per workload through its normal runtime model
configuration. Anymodel passes that selected value through; it does not hard
code a default, downgrade it to `none`, or let a provider-specific adapter
silently override it. A role may define its own evaluated default and record
the selected value with its run.

For the OpenAI provider, a request with `reasoning` uses `/v1/responses`.
The caller continues to provide the existing `messages`, `tools`, and
`tool_choice` fields. Existing requests without `reasoning` retain their
current provider routing and behavior.

## Provider translation

The OpenAI adapter translates:

- Anymodel function tools into Responses function-tool definitions.
- An assistant `tool_calls` message into Responses `function_call` items.
- A `tool` message with `tool_call_id` into a `function_call_output` item.
- Responses `function_call` items back into Anymodel `ToolCall` values,
  preserving the provider call ID as `tool_call_id`.
- OpenAI response/reasoning continuation state so the follow-up request can
  continue the same reasoning turn.

The adapter must not send `reasoning_effort: none` as an implicit workaround.
The caller chooses the reasoning effort explicitly; unsupported providers
either reject `reasoning` with a clear capability error or ignore it only when
their documented compatibility policy permits that behavior.

## Authority and boundaries

Anymodel only translates model and tool-call protocol. It does not execute a
caller’s function tool, decide tool arguments, or persist application state.
The caller owns tool execution and appends the result through the existing
message contract.

## Acceptance criteria

1. An OpenAI GPT-5.6 request with `reasoning: { effort: 'low' }` and a function
   tool uses `/v1/responses`, not `/v1/chat/completions`.
2. A Responses `function_call` is returned as an Anymodel assistant tool call
   with a stable call ID and JSON arguments.
3. Supplying the matching tool result produces a valid Responses
   `function_call_output` continuation and a final Anymodel completion.
4. Existing OpenAI Chat Completions tool calls without `reasoning` remain
   unchanged.
5. Anthropic, Google, Perplexity, XAI, and OpenAI-compatible provider behavior
   remains unchanged unless and until each receives an explicit Responses-like
   feature.
6. Tests cover request translation, response translation, a complete
   function-call round trip, malformed function arguments, and unsupported
   reasoning-provider handling.
