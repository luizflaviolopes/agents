import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { agentBuilderRequestSchema } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MODEL_CHOICES = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
];

const SYSTEM_PROMPT = `You are an expert at designing task-specific AI agents for Agent Fleet, a platform where each agent runs on the Claude Agent SDK inside a project.

Given a user's description, design one agent and propose it via the propose_agent tool. Guidance:
- Write thorough markdown instructions covering: the agent's role, its concrete responsibilities, guardrails (what it must never do, when to stop and report instead of guessing), and output expectations (format, level of detail, how to report results).
- Instructions are the agent's system prompt — write them in the second person ("You are…") and make them self-contained; the agent cannot see this conversation.
- Pick the cheapest model that can do the job well: claude-haiku-4-5-20251001 for simple/repetitive work, claude-sonnet-5 for most engineering and writing work (good default), claude-opus-5 only for deep reasoning or large autonomous tasks.
- Set needsWorkspace to true when the agent must read or modify code in cloned repositories.
- Suggest MCP servers only when the task clearly requires an external system (e.g. GitHub API, a database, a ticketing system); keep the list minimal.
- Plugins are optional named capability packs; suggest them sparingly, only if the description implies one.
- The name should be short and role-like (e.g. "Code reviewer", "Docs writer").`;

const PROPOSE_AGENT_TOOL: Anthropic.Messages.Tool = {
  name: "propose_agent",
  description:
    "Propose a complete agent configuration for review. Always call this tool exactly once with your best proposal.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short, role-like agent name (max 120 chars).",
      },
      instructions: {
        type: "string",
        description:
          "Thorough markdown system prompt: role, responsibilities, guardrails, output expectations.",
      },
      model: {
        type: "string",
        enum: MODEL_CHOICES,
        description: "The Claude model this agent should run on.",
      },
      plugins: {
        type: "array",
        items: { type: "string" },
        description: "Optional plugin names. Usually empty.",
      },
      mcpServers: {
        type: "array",
        description:
          "MCP servers the agent needs. Prefer none unless clearly required.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["stdio", "http", "sse"] },
            command: {
              type: "string",
              description: "Executable for stdio servers.",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments for stdio servers.",
            },
            url: {
              type: "string",
              description: "Endpoint for http/sse servers.",
            },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "Environment variables (use placeholder values for secrets).",
            },
          },
          required: ["name", "type"],
        },
      },
      needsWorkspace: {
        type: "boolean",
        description:
          "True when the agent must work inside cloned repositories.",
      },
      reasoning: {
        type: "string",
        description:
          "One or two sentences for the user explaining the key design choices.",
      },
    },
    required: ["name", "instructions", "model", "needsWorkspace", "reasoning"],
  },
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = agentBuilderRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  // RLS-scoped check that the project belongs to this user.
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", parsed.data.projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [PROPOSE_AGENT_TOOL],
      tool_choice: { type: "tool", name: "propose_agent" },
      messages: [
        {
          role: "user",
          content: `Design an agent for this request:\n\n${parsed.data.idea}`,
        },
      ],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === "propose_agent",
    );

    if (!toolUse) {
      return NextResponse.json(
        { error: "The model did not return a proposal. Try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ proposal: toolUse.input });
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? `Anthropic API error (${err.status}): ${err.message}`
        : "Agent builder failed unexpectedly.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
