// Real adapter, broker queue/activity/fence, session and authority.
// Socket startup and browser/DOM observations are replaced only in memory.
import assert from "node:assert/strict";
import { test } from "bun:test";

const root = import.meta.dir + "/..";
const moduleAt = (name: string) =>
  import(root + "/src/adapters/chatgpt-web/" + name + ".ts");

const [
  { ChatGptBrowserWorker },
  { createChatGptWebAdapter, chatGptWebExecutionNamespace },
  { TurnBroker },
  { chatGptTurnExecutionKey, chatGptTurnSessions },
] = await Promise.all([
  moduleAt("browser-worker"), moduleAt("index"), moduleAt("turn-broker"),
  moduleAt("turn-execution"),
]);

function request(label: string, cwd = "/tmp/architecture-probe") {
  const turnId = "turn_" + label;
  const env =
    "<environment_context><cwd>" + cwd +
    "</cwd><filesystem><workspace_roots><root>" + cwd +
    "</root></workspace_roots><permission_profile type=\"disabled\">" +
    "<file_system type=\"unrestricted\" /></permission_profile>" +
    "</filesystem></environment_context>";
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      tools: [{
        name: "exec_command",
        description: "Run command",
        parameters: { type: "object" },
      }],
      messages: [{
        role: "user", content: "Inspect the project", timestamp: 1,
      }] as any[],
    },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_" + label,
          turn_id: turnId,
        }),
      },
      input: [env, "Inspect the project"].map(text => ({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      })) as any[],
    },
  };
}

function fixture(label: string) {
  const broker: any = TurnBroker.forSocket(
    "/tmp/authority-probe-" + process.pid + "-" + label + ".sock",
  );
  // Disable only transport startup. Broker business methods remain real.
  broker.start = async () => {};

  const rpc = (data: any) => {
    const req = { id: "probe", ...data };
    broker.validateRequest(req);
    return broker.dispatch(req);
  };

  let token = "";
  const environments: string[] = [];
  const register = broker.register.bind(broker);
  broker.register = async (...args: any[]) =>
    token = await register(...args);

  const update = broker.updateEnvironment.bind(broker);
  broker.updateEnvironment = (value: string, environment: any) => {
    environments.push(environment.cwd);
    return update(value, environment);
  };

  const provider = {
    adapter: "chatgpt-web",
    baseUrl: "browser://authority-probe-" + label,
    chatgptWeb: {
      browserHost: "managed-chrome",
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const worker: any = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const adapter = createChatGptWebAdapter(provider, { broker });

  return {
    broker, rpc, provider, worker, adapter, environments,
    token: () => token,
    session: (parsed: any) => chatGptTurnSessions.find(
      chatGptWebExecutionNamespace(provider) + ":" +
      chatGptTurnExecutionKey(parsed),
    ),
    close: async () => {
      worker.run = originalRun;
      await broker.close();
    },
  };
}

const run = async (adapter: any, parsed: any) => {
  const events: any[] = [];
  await adapter.runTurn(
    parsed,
    { headers: new Headers() },
    (event: any) => events.push(event),
  );
  return events;
};

async function finalWorker(turn: any, lateFailure: boolean) {
  await turn.prepare();
  await turn.onSendActivated();
  turn.onSubmitted();
  turn.onBrowserFact({
    browserEpoch: 0,
    sourceSequence: 1,
    event: {
      type: "final_candidate", answer: "committed answer", source: "wire",
    },
  });
  const revision = await turn.completionFence.begin();
  assert.notEqual(revision, undefined);
  assert.equal(await turn.completionFence.commit(revision), true);
  turn.onTextDelta("committed answer", "wire");
  turn.onPhysicalRelease({ released: true });
  if (lateFailure) {
    throw new Error("injected late storageState/diagnostic failure");
  }
  return "committed answer";
}

async function earlyTool() {
  const f = fixture("early");
  const parsed = request("early");
  f.worker.run = async (turn: any) => {
    await turn.prepare();
    await turn.onSendActivated();
    const claim = await f.rpc({method:"claim",token:f.token(),activityId:"activity_"+"e".repeat(16)});
    const invocation = f.rpc({method:"invoke",bindingId:claim.bindingId,wireName:"exec_command",arguments:{cmd:"pwd"}});
    while (!turn.externalProgress.snapshot().lastToolBatchRevision) await turn.externalProgress.waitForChange(0);
    const revision=turn.externalProgress.snapshot().lastToolBatchRevision;
    await turn.externalProgress.acknowledgeToolBatch(revision);
    turn.onBrowserFact({browserEpoch:0,sourceSequence:1,event:{type:"tool_boundary_observed",revision}});
    turn.onSubmitted();
    await invocation;
    await f.rpc({method:"activity_complete",token:f.token(),activityId:"activity_"+"e".repeat(16)});
    const answer="tool completed";
    turn.onBrowserFact({browserEpoch:0,sourceSequence:2,event:{type:"final_candidate",answer,source:"dom"}});
    const fence=await turn.completionFence.begin();
    assert.notEqual(fence,undefined);
    assert.equal(await turn.completionFence.commit(fence),true);
    turn.onTextDelta(answer,"dom");
    turn.onPhysicalRelease({released:true});
    return answer;
  };
  try {
    const first=await run(f.adapter,parsed);
    const tool=first.find(e=>e.type==="tool_call_start");
    assert.ok(tool);
    const session=f.session(parsed);
    assert.equal(session.authority.snapshot().toolBatchRevision,1);
    const follow=structuredClone(parsed);
    follow.context.messages.push({role:"toolResult",toolCallId:tool.id,toolName:"exec_command",content:"done",isError:false,timestamp:2});
    follow._rawBody.input.push({type:"function_call_output",call_id:tool.id,output:"done"});
    const second=await run(f.adapter,follow);
    assert.deepEqual(await session.browserOutcome, { type: "final", answer: "tool completed" });
    assert.ok(second.some(e=>e.type==="done"&&e.endTurn));
    assert.equal(session.authority.snapshot().terminal?.kind,"final");
  } finally {await f.close();}
}

test("a broker tool call before submitted keeps the accepted native turn alive", earlyTool);
