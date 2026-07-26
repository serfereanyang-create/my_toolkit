# API Proxy Dual-Protocol Streaming Design

## Goal

Make the local gateway compatible with ZCode requests using either OpenAI Chat Completions or OpenAI Responses. Local connectivity probes must complete immediately, while all real model requests are forwarded upstream with streaming enabled.

The upstream remains `https://yunqiaoai.dpdns.org` by user choice. The gateway must not fabricate model output when that upstream has no channel for `gpt-5.6-sol`.

## Request Classification

The gateway handles `/chat/completions` and `/responses` independently.

A request is a local probe only when it is a small, tool-free request whose sole user input is `hi` and whose output-token limit is one. Probe detection is protocol-specific and must not classify a normal conversation as a probe.

All non-probe requests are real model requests.

## Probe Responses

For a Chat Completions probe, return a valid non-streaming Chat Completions response containing `ok` and minimal usage.

For a Responses probe, return a valid non-streaming Responses response containing an `output_text` item with `ok` and minimal usage.

Probe responses never reach the upstream.

## Real Request Transformation

For both protocols:

- Strip a leading ZCode provider UUID from the model name.
- Set `stream` to `true`, regardless of the incoming value or whether it was omitted.
- Preserve messages/input, tools, tool choice, reasoning configuration, token limits, and all other payload fields.

The transformed request body is serialized once before forwarding.

## Upstream Routing

Route each local endpoint to its matching versioned upstream endpoint:

- `/chat/completions` -> `/v1/chat/completions`
- `/responses` -> `/v1/responses`
- `/models` -> `/v1/models`

This routing is endpoint-specific and does not allow a selected UI mode to leave one supported endpoint unversioned.

## Response and Error Handling

Successful streaming responses are passed through without changing SSE events.

An upstream non-2xx JSON error retains its status and body. An upstream HTML response is not treated as successful model output: the gateway returns a structured `502 invalid_upstream_response` error before model parsing begins.

Existing upstream response and stream idle timeouts remain in place. Logs continue to include the request ID, upstream status, duration, and byte count.

## Testing

Automated tests cover:

- Chat probe classification and response.
- Responses probe classification and response.
- Real Chat request forced to `stream: true`.
- Real Responses request forced to `stream: true`.
- Provider UUID model-prefix removal in both protocols.
- Endpoint-specific `/v1` routing.
- HTML `200` upstream responses rejected as invalid.

Live verification checks gateway health and makes one request through each protocol. A `model_not_found` result from the retained cloud-bridge upstream is reported as an upstream limitation, not as a gateway failure.
