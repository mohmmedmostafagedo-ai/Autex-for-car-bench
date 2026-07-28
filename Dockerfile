# CAR-bench Track 2 — Agent-under-test image.
#
# This image runs ONLY the agent harness (deterministic policy logic +
# configurable LLM call), not the full Autex dashboard application. The
# dashboard's Next.js build, UI components, and Firebase/Genkit integrations
# are unrelated to the evaluation loop and are intentionally excluded to
# keep the image small and the audit surface minimal.
#
# All model/provider selection is environment-driven (see
# src/lib/car-bench-agent-adapter.ts) — nothing here hard-codes a model,
# provider, deployment name, API base, service tier, or reasoning-effort
# value, per the Track 2 submission rules.

FROM node:20-slim AS base
WORKDIR /agent

# Install only what the agent harness needs: tsx (TS runtime) + node types.
# We intentionally do NOT run `npm install` against the full package.json
# (which pulls in Next.js, Radix UI, Firebase, Genkit, etc.) since none of
# that is reachable from the agent entrypoint.
COPY agent-package.json package.json
RUN npm install --omit=dev

# Copy only the source files the agent entrypoint actually imports.
COPY src/lib/car-bench-agent-adapter.ts ./src/lib/car-bench-agent-adapter.ts
COPY src/lib/car-bench-reliability-agent.ts ./src/lib/car-bench-reliability-agent.ts
COPY src/lib/car-bench-tool-result-validator.ts ./src/lib/car-bench-tool-result-validator.ts
COPY src/lib/car-bench-system-prompt.ts ./src/lib/car-bench-system-prompt.ts
COPY src/lib/car-bench-track2-budget.ts ./src/lib/car-bench-track2-budget.ts
COPY src/lib/mpae.ts ./src/lib/mpae.ts
COPY scripts/run-carbench-agent-entrypoint.ts ./scripts/run-carbench-agent-entrypoint.ts
COPY tsconfig.agent.json ./tsconfig.json

# Non-root runtime user.
RUN useradd --create-home --shell /bin/bash agent
USER agent

# No secrets are baked in. All required values are supplied by the
# evaluator at run time via [agent_under_test.env] in scenario.toml:
#   AGENT_LLM, AGENT_API_KEY  (required)
#   AGENT_API_BASE, AGENT_TEMPERATURE, AGENT_REASONING_EFFORT,
#   AGENT_THINKING_BUDGET_TOKENS, AGENT_API_STYLE  (optional)
ENTRYPOINT ["npx", "tsx", "scripts/run-carbench-agent-entrypoint.ts"]
