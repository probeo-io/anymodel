/**
 * Basic usage examples for @probeo/anymodel
 *
 * Set at least one API key before running:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export OPENAI_API_KEY=sk-...
 *   export GOOGLE_API_KEY=AIza...
 *
 * Run with:
 *   npx tsx examples/basic.ts
 */

import { AnyModel } from "../src/index.js";

const client = new AnyModel({
  aliases: {
    default: "anthropic/claude-sonnet-4-6",
    fast: "anthropic/claude-haiku-4-5",
  },
  defaults: {
    temperature: 0.7,
    max_tokens: 1024,
  },
});

// ── Simple completion ────────────────────────────────────────────────────────

async function simpleCompletion() {
  console.log("=== Simple Completion ===\n");

  const response = await client.chat.completions.create({
    model: "default", // resolves to anthropic/claude-sonnet-4-6
    messages: [{ role: "user", content: "What is the capital of France? One sentence." }],
  });

  console.log(response.choices[0].message.content);
  console.log(`\nTokens: ${response.usage.total_tokens}\n`);
}

// ── Streaming ────────────────────────────────────────────────────────────────

async function streaming() {
  console.log("=== Streaming ===\n");

  const stream = (await client.chat.completions.create({
    model: "fast",
    messages: [{ role: "user", content: "Write a haiku about programming." }],
    stream: true,
  })) as AsyncIterable<any>;

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || "";
    process.stdout.write(text);
  }
  console.log("\n");
}

// ── Tool calling ─────────────────────────────────────────────────────────────

async function toolCalling() {
  console.log("=== Tool Calling ===\n");

  const response = await client.chat.completions.create({
    model: "default",
    messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
              units: { type: "string", enum: ["celsius", "fahrenheit"] },
            },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
  });

  const msg = response.choices[0].message;
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      console.log(`Tool: ${call.function.name}`);
      console.log(`Args: ${call.function.arguments}`);
    }
  } else {
    console.log(msg.content);
  }
  console.log();
}

// ── Fallback routing ─────────────────────────────────────────────────────────

async function fallbackRouting() {
  console.log("=== Fallback Routing ===\n");

  const response = await client.chat.completions.create({
    model: "",
    models: [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "google/gemini-2.5-flash",
    ],
    route: "fallback",
    messages: [{ role: "user", content: "Say hello in three languages." }],
  });

  console.log(`Model used: ${response.model}`);
  console.log(response.choices[0].message.content);
  console.log();
}

// ── Batch processing ─────────────────────────────────────────────────────────

async function batchProcessing() {
  console.log("=== Batch Processing ===\n");

  const results = await client.batches.createAndPoll(
    {
      model: "fast",
      requests: [
        { custom_id: "capital-1", messages: [{ role: "user", content: "Capital of Japan? One word." }] },
        { custom_id: "capital-2", messages: [{ role: "user", content: "Capital of Brazil? One word." }] },
        { custom_id: "capital-3", messages: [{ role: "user", content: "Capital of Kenya? One word." }] },
      ],
    },
    { interval: 500 },
  );

  for (const r of results.results) {
    const answer = r.response?.choices[0].message.content || r.error?.message;
    console.log(`${r.custom_id}: ${answer}`);
  }

  console.log(`\nTotal tokens: ${results.usage_summary.total_prompt_tokens + results.usage_summary.total_completion_tokens}`);
  console.log();
}

// ── Generation stats ─────────────────────────────────────────────────────────

async function generationStats() {
  console.log("=== Generation Stats ===\n");

  const response = await client.chat.completions.create({
    model: "default",
    messages: [{ role: "user", content: "Hi" }],
  });

  const stats = client.generation.get(response.id);
  if (stats) {
    console.log(`Model:    ${stats.model}`);
    console.log(`Provider: ${stats.provider_name}`);
    console.log(`Latency:  ${stats.latency}ms`);
    console.log(`Prompt:   ${stats.tokens_prompt} tokens`);
    console.log(`Output:   ${stats.tokens_completion} tokens`);
  }
  console.log();
}

// ── Run examples ─────────────────────────────────────────────────────────────

async function main() {
  const example = process.argv[2];

  const examples: Record<string, () => Promise<void>> = {
    completion: simpleCompletion,
    stream: streaming,
    tools: toolCalling,
    fallback: fallbackRouting,
    batch: batchProcessing,
    stats: generationStats,
  };

  if (example && examples[example]) {
    await examples[example]();
  } else if (!example) {
    // Run all
    for (const [name, fn] of Object.entries(examples)) {
      try {
        await fn();
      } catch (err: any) {
        console.log(`[${name}] Skipped: ${err.message}\n`);
      }
    }
  } else {
    console.log(`Unknown example: ${example}`);
    console.log(`Available: ${Object.keys(examples).join(", ")}`);
  }
}

main().catch(console.error);
