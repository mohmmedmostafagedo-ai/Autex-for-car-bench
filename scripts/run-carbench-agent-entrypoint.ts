/**
 * CAR-bench Track 2 A2A HTTP agent entrypoint.
* The competition runner starts the agent as a long-lived A2A service and
 * passes --host, --port, and --card-url. This server keeps one adapter state
 * per A2A context_id, exposes the Agent Card at /.well-known/agent-card.json,
 * and accepts JSON-RPC A2A send-message requests on /.
 */
 
 
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { generate_next_message, get_init_state, type CarBenchAdapterState, type CarBenchGenerateInput } from '../src/lib/car-bench-agent-adapter';

type JsonObject = Record<string, unknown>;


type CliArgs = {
  host: string;
  port: number;
  cardUrl?: string;
};


const states = new Map<string, CarBenchAdapterState>();
const contextTools = new Map<string, CarBenchGenerateInput['availableTools']>();
const contextTaskTypes = new Map<string, CarBenchGenerateInput['taskType']>();


function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '0.0.0.0', port: 8080 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--host' && next) {
      args.host = next;
      i += 1;
    } else if (flag === '--port' && next) {
      args.port = Number(next);
      i += 1;
    } else if (flag === '--card-url' && next) {
      args.cardUrl = next;
      i += 1;
    }
  }
  return args;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/a2a+json',
    'a2a-version': '1.0',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function partKind(part: JsonObject): 'text' | 'data' | undefined {
  if (typeof part.text === 'string' || (part.text && typeof part.text === 'object')) return 'text';
  if (part.data && typeof part.data === 'object') return 'data';
  if (part.kind === 'text' || part.type === 'text') return 'text';
  if (part.kind === 'data' || part.type === 'data') return 'data';
  return undefined;
}

function partText(part: JsonObject): string {
  if (typeof part.text === 'string') return part.text;
  const nested = part.text as JsonObject | undefined;
  if (nested && typeof nested.text === 'string') return nested.text;
  return '';
}

function decodeProtoValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const obj = value as JsonObject;
  if ('stringValue' in obj) return obj.stringValue;
  if ('numberValue' in obj) return obj.numberValue;
  if ('boolValue' in obj) return obj.boolValue;
  if ('nullValue' in obj) return null;
  if (obj.structValue && typeof obj.structValue === 'object') {
    const fields = (obj.structValue as JsonObject).fields as JsonObject | undefined;
    return decodeProtoFields(fields ?? {});
  }
  if (obj.listValue && typeof obj.listValue === 'object') {
    const values = (obj.listValue as JsonObject).values;
    return Array.isArray(values) ? values.map(decodeProtoValue) : [];
  }
  return obj;
}

function decodeProtoFields(fields: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeProtoValue(value)]));
}

function partData(part: JsonObject): JsonObject | undefined {
  if (!part.data || typeof part.data !== 'object') return undefined;
  const data = part.data as JsonObject;
  if (data.fields && typeof data.fields === 'object') return decodeProtoFields(data.fields as JsonObject);
  return data;
}

function extractMessage(params: unknown): JsonObject {
  const obj = (params && typeof params === 'object') ? params as JsonObject : {};
  const message = obj.message ?? obj.request ?? obj;
  return (message && typeof message === 'object') ? message as JsonObject : {};
}

function extractContextId(message: JsonObject, params: unknown): string {
  const paramsObj = (params && typeof params === 'object') ? params as JsonObject : {};
  const value = message.context_id ?? message.contextId ?? paramsObj.context_id ?? paramsObj.contextId;
  return typeof value === 'string' && value ? value : 'default';
}

function normalizeTools(data: JsonObject | undefined): CarBenchGenerateInput['availableTools'] {
  const rawTools = Array.isArray(data?.tools) ? data.tools : [];
  return rawTools.map((tool) => {
    const obj = (tool && typeof tool === 'object') ? tool as JsonObject : {};
    const fn = (obj.function && typeof obj.function === 'object') ? obj.function as JsonObject : obj;
    const parameters = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters as JsonObject : {};
    const required = Array.isArray(parameters.required) ? parameters.required.map(String) : undefined;
    return {
      name: String(fn.name ?? obj.name ?? 'unknown_tool'),
      requiredParameters: required,
    };
  });
}

function extractUserMessage(text: string): string {
  const userIndex = text.lastIndexOf('User:');
  if (userIndex >= 0) return text.slice(userIndex + 'User:'.length).trim() || 'none';
  return text.trim() || 'none';
}

function inferTaskType(text: string): CarBenchGenerateInput['taskType'] {
  const lower = text.toLowerCase();
  if (lower.includes('ambiguous') || lower.includes('clarif') || lower.includes('disambigu')) return 'disambiguation';
  if (lower.includes('unavailable') || lower.includes('capability') || lower.includes('hallucinat')) return 'hallucination';
  return 'base';
}

function buildInput(message: JsonObject, contextId: string): CarBenchGenerateInput {
  const parts = Array.isArray(message.parts) ? message.parts as JsonObject[] : [];
  const text = parts.filter((part) => partKind(part) === 'text').map(partText).filter(Boolean).join('\n');
  const dataParts = parts.filter((part) => partKind(part) === 'data').map(partData).filter(Boolean) as JsonObject[];
  const toolsData = dataParts.find((data) => Array.isArray(data.tools));
  const toolResultsData = dataParts.find((data) => Array.isArray(data.tool_results));
  const incomingTools = normalizeTools(toolsData);
  if (incomingTools.length > 0) contextTools.set(contextId, incomingTools);
  const taskType = text ? inferTaskType(text) : (contextTaskTypes.get(contextId) ?? 'base');
  contextTaskTypes.set(contextId, taskType);

  return {
    userMessage: extractUserMessage(text),
    taskType,
    availableTools: contextTools.get(contextId) ?? [],
    vehicleContext: {},
    observedToolResults: Array.isArray(toolResultsData?.tool_results) ? toolResultsData.tool_results as CarBenchGenerateInput['observedToolResults'] : undefined,
  };
}

function toA2AMessage(contextId: string, adapterMessage: Awaited<ReturnType<typeof generate_next_message>>['message']): JsonObject {
  const parts: JsonObject[] = [];
  if (adapterMessage.content) {
    parts.push({ text: adapterMessage.content });
  }
  if (adapterMessage.tool_calls?.length) {
    parts.push({
      data: {
        tool_calls: adapterMessage.tool_calls.map((call) => ({
          tool_name: call.name,
          arguments: call.arguments,
        })),
      },
    });
  }
  const message: JsonObject = {
    role: 'ROLE_AGENT',
    context_id: contextId,
    contextId,
    parts,
  };
  if (!adapterMessage.tool_calls?.length) {
    message.metadata = {
      turn_metrics: {
        prompt_tokens: adapterMessage.metadata.turn_metrics.prompt_tokens,
        completion_tokens: adapterMessage.metadata.turn_metrics.completion_tokens,
        cost: 0.0,
        model: process.env.AGENT_LLM ?? 'autex-deterministic-harness',
        thinking_tokens: adapterMessage.metadata.turn_metrics.thinking_tokens,
        num_llm_calls: 0,
        avg_llm_call_time_ms: 0.0,
        num_passes: 1,
        quota_wait_time_ms: 0.0,
      },
    };
  }
  return message;
}

function agentCard(url: string): JsonObject {
  return {
    name: 'autex_carbench_track2_agent',
    description: 'Autex CAR-bench Track 2 in-car assistant exposed as an A2A HTTP service.',
    version: '1.0.0',
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    skills: [{
      id: 'car_assistant',
      name: 'In-Car Voice Assistant',
      description: 'Returns CAR-bench text responses or tool calls through A2A.',
      tags: ['benchmark', 'car-bench', 'voice-assistant', 'track-2'],
    }],
  };
}

async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let rpc: JsonObject = {};
  try {
    rpc = raw ? JSON.parse(raw) as JsonObject : {};
  } catch {
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = rpc.id ?? null;
  try {
    const params = rpc.params;
    const message = extractMessage(params);
    const contextId = extractContextId(message, params);
    if (typeof rpc.method === 'string' && rpc.method.toLowerCase().includes('cancel')) {
      states.delete(contextId);
      contextTools.delete(contextId);
      contextTaskTypes.delete(contextId);
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { ok: true } });
      return;
    }

    const result = await generate_next_message(state, input as CarBenchGenerateInput);
    state = result.state;
    process.stdout.write(`${JSON.stringify(result.message)}\n`);
    const state = states.get(contextId) ?? get_init_state();
    const result = await generate_next_message(state, buildInput(message, contextId));
    states.set(contextId, result.state);
    sendJson(res, 200, { jsonrpc: '2.0', id, result: toA2AMessage(contextId, result.message) });
  } catch (error) {sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

const args = parseArgs(process.argv.slice(2));
const cardUrl = args.cardUrl || `http://${args.host}:${args.port}/`;
const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && (req.url === '/.well-known/agent-card.json' || req.url === '/.well-known/agent.json')) {
      sendJson(res, 200, agentCard(cardUrl));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && (req.url === '/' || req.url === '/a2a' || req.url === '/message:send')) {
      await handleRpc(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  })().catch((error) => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(args.port, args.host, () => {
  console.error(`Autex CAR-bench A2A server listening on ${args.host}:${args.port}`);
}); 

                                        
