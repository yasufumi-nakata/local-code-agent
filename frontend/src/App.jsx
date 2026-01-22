import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const API_BASE_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

const DEFAULT_SYSTEM_PROMPT = `
You are the Local Code Agent, a senior software engineer running on a local machine.
You can request these tools: read_file, write_file, run_command, list_files, web_search.
Use web_search by default when you need fresh or external information.
When you decide to use a tool, respond ONLY with a JSON object:
{"tool":"tool_name","params":{"param1":"value1"}}
No extra text around the JSON.

When a task needs multiple steps, keep iterating until completion.
When you do not need a tool, respond ONLY with the final output. Do not include reasoning, steps, or status updates.
When the task is complete, respond with "DONE:" followed by the final output.
If multiple tasks are provided, handle them in order and label which task you are addressing.
Tool results will arrive as user messages prefixed with "Tool result:".
Ask clarifying questions only when blocked.
`.trim();

const PROMPT_TEMPLATE = `Goal:
Context:
Constraints:
Output format:`;

const ROLE_LABELS = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

const STATUS_CONFIG = {
  idle: {
    label: "Idle",
    className:
      "bg-[rgba(15,23,42,0.6)] text-[var(--vscode-muted)] border border-[var(--vscode-border)]",
  },
  running: {
    label: "Running",
    className:
      "bg-[rgba(45,212,191,0.2)] text-[#5eead4] border border-[rgba(45,212,191,0.45)]",
  },
  awaiting: {
    label: "Awaiting",
    className:
      "bg-[rgba(246,199,68,0.2)] text-[#fcd34d] border border-[rgba(246,199,68,0.5)]",
  },
  done: {
    label: "Done",
    className:
      "bg-[rgba(34,197,94,0.18)] text-[#86efac] border border-[rgba(34,197,94,0.45)]",
  },
  failed: {
    label: "Failed",
    className:
      "bg-[rgba(239,68,68,0.18)] text-[#fca5a5] border border-[rgba(239,68,68,0.45)]",
  },
};

const PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
];

const DEFAULT_PERMISSION_POLICY = {
  read_file: "allow",
  list_files: "allow",
  web_search: "allow",
  write_file: "allow",
  run_command: "allow",
};

const APPROVAL_SOURCES = {
  agent: "Agent",
  console: "Tool Console",
  editor_read: "Editor Read",
  editor_write: "Editor Write",
  explorer_list: "Explorer",
};

const TOOL_PRESETS = {
  run_command: { command: "" },
  read_file: { file_path: "" },
  write_file: { file_path: "", content: "" },
  list_files: { path: "." },
  web_search: { query: "", max_results: 5 },
};

const TOOL_LABELS = {
  run_command: "run_command",
  read_file: "read_file",
  write_file: "write_file",
  list_files: "list_files",
  web_search: "web_search",
};

const TOOL_NAMES = new Set(Object.keys(TOOL_PRESETS));
const DONE_MARKER = /^\s*DONE:/i;
const stripDoneMarker = (text = "") =>
  DONE_MARKER.test(text) ? text.replace(DONE_MARKER, "").trimStart() : text;

const PANEL_INPUT_BASE =
  "rounded-xl border border-[var(--vscode-border)] bg-[var(--vscode-panel)] text-[var(--vscode-text)] placeholder:text-[var(--vscode-muted)] shadow-sm transition-all focus:outline-none focus:border-[var(--vscode-accent)] focus:ring-2 focus:ring-[var(--vscode-accent)]/30 backdrop-blur";
const EDITOR_INPUT_BASE =
  "rounded-xl border border-[var(--vscode-border)] bg-[var(--vscode-editor)] text-[var(--vscode-text)] placeholder:text-[var(--vscode-muted)] shadow-sm transition-all focus:outline-none focus:border-[var(--vscode-accent)] focus:ring-2 focus:ring-[var(--vscode-accent)]/30 backdrop-blur";
const INPUT_SM = `${PANEL_INPUT_BASE} px-3 py-2 text-[11px]`;
const INPUT_MD = `${PANEL_INPUT_BASE} px-3 py-2 text-[12px]`;
const TEXTAREA_SM = `${PANEL_INPUT_BASE} px-3 py-2 text-[11px] leading-relaxed`;
const TEXTAREA_COMPACT = `${PANEL_INPUT_BASE} px-3 py-2 text-[11px] leading-relaxed`;
const TEXTAREA_MD = `${PANEL_INPUT_BASE} px-3 py-2 text-[12px] leading-relaxed`;
const TEXTAREA_EDITOR = `${EDITOR_INPUT_BASE} px-3 py-2 text-[11px] leading-relaxed`;

const ACTIVITY_ITEMS = [
  { id: "workspace", label: "Workspace", glyph: "WS" },
  { id: "config", label: "Config", glyph: "CFG" },
];

const PANEL_TABS = [
  { id: "tools", label: "Tools" },
  { id: "permissions", label: "Permissions" },
  { id: "editor", label: "File Editor" },
];

const createId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createTask = (index) => ({
  id: createId(),
  title: `Task ${index}`,
  prompt: "",
  contextInput: "",
  status: "idle",
  messages: [],
  pendingToolCall: null,
  error: "",
  stepCount: 0,
});

const normalizeContextFiles = (input) =>
  input
    .split(/\s+/)
    .map((entry) => entry.trim().replace(/,$/, ""))
    .filter(Boolean);

const findFirstJsonObject = (text) => {
  const startIndex = text.indexOf("{");
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
};

const extractToolCall = (text) => {
  if (!text) {
    return null;
  }

  const codeMatch =
    text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  const candidate = codeMatch ? codeMatch[1] : text;
  const jsonText =
    findFirstJsonObject(candidate) ??
    (candidate !== text ? findFirstJsonObject(text) : null);

  const parseToolCallJson = (source, toolHint) => {
    if (!source) {
      return null;
    }
    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const namedTool =
        typeof parsed.tool === "string"
          ? parsed.tool
          : typeof parsed.name === "string"
            ? parsed.name
            : null;
      if (namedTool) {
        const toolName = namedTool.trim();
        if (!TOOL_NAMES.has(toolName)) {
          return null;
        }
        let params =
          parsed.params ?? parsed.arguments ?? parsed.args ?? {};
        if (typeof params === "string") {
          try {
            params = JSON.parse(params);
          } catch {
            params = {};
          }
        }
        if (!params || typeof params !== "object") {
          params = {};
        }
        return { tool: toolName, params };
      }

      if (toolHint && TOOL_NAMES.has(toolHint)) {
        let params = parsed;
        if (
          parsed.arguments !== undefined &&
          Object.keys(parsed).length === 1
        ) {
          params = parsed.arguments;
        }
        if (typeof params === "string") {
          try {
            params = JSON.parse(params);
          } catch {
            params = {};
          }
        }
        if (!params || typeof params !== "object") {
          params = {};
        }
        return { tool: toolHint, params };
      }

      return null;
    } catch (error) {
      return null;
    }
  };

  const toolTagMatch = text.match(/to=([a-zA-Z_][\w-]*)/);
  const toolHint = toolTagMatch?.[1]?.trim() ?? null;

  const directCall = parseToolCallJson(jsonText, toolHint);
  if (directCall) {
    return directCall;
  }

  if (toolTagMatch && toolHint) {
    const afterTag = text.slice(toolTagMatch.index + toolTagMatch[0].length);
    const tagJson = findFirstJsonObject(afterTag);
    const taggedCall = parseToolCallJson(tagJson, toolHint);
    if (taggedCall) {
      return taggedCall;
    }
  }

  return null;
};

const getRunCommandRisk = (command = "") => {
  const normalized = command.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/(rm\s+-rf|sudo|mkfs|dd\s)/.test(normalized)) {
    return { level: "high", label: "High risk command" };
  }
  if (/(rm\s+|mv\s+|chmod\s+|chown\s+|>\s|>>\s)/.test(normalized)) {
    return { level: "medium", label: "Check command" };
  }
  return null;
};

const getPathRisk = (path = "") => {
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.includes("..")) {
    return "outside";
  }
  return null;
};

const parseListFilesResult = (result = "") => {
  const lines = result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const truncated = lines.some((line) => line.includes("(truncated)"));
  return {
    entries: lines.filter((line) => !line.includes("(truncated)")),
    truncated,
  };
};

const normalizeExplorerRoot = (root = "") => {
  const trimmed = root.trim();
  return trimmed || ".";
};

const formatExplorerEntry = (entry = "", root = "") => {
  const normalizedRoot = normalizeExplorerRoot(root).replace(/\/+$/, "");
  if (!normalizedRoot || normalizedRoot === ".") {
    return entry.replace(/^\.\//, "");
  }
  const prefix = `${normalizedRoot}/`;
  if (entry.startsWith(prefix)) {
    return entry.slice(prefix.length);
  }
  return entry;
};

const summarizeApproval = (approval) => {
  if (!approval) {
    return "";
  }
  const { tool, params } = approval.toolCall ?? {};
  if (tool === "run_command") {
    return params?.command ?? "";
  }
  if (tool === "read_file" || tool === "write_file") {
    return params?.file_path ?? "";
  }
  if (tool === "list_files") {
    return params?.path ?? "";
  }
  if (tool === "web_search") {
    return params?.query ?? "";
  }
  return "";
};

function App() {
  const taskCounter = useRef(1);
  const initialTasks = useRef([createTask(taskCounter.current++)]);
  const [tasks, setTasks] = useState(() => initialTasks.current);
  const [activeTaskId, setActiveTaskId] = useState(
    () => initialTasks.current[0]?.id ?? null,
  );
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [sharedThread, setSharedThread] = useState(false);
  const [autoRunTools, setAutoRunTools] = useState(true);
  const [autoContinue, setAutoContinue] = useState(true);
  const [maxSteps, setMaxSteps] = useState(6);
  const [sharedMessages, setSharedMessages] = useState([]);
  const [runAllInProgress, setRunAllInProgress] = useState(false);
  const [activeView, setActiveView] = useState("workspace");
  const [activePanel, setActivePanel] = useState("tools");
  const [permissionPolicy, setPermissionPolicy] = useState(
    DEFAULT_PERMISSION_POLICY,
  );
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [noLookMode, setNoLookMode] = useState(true);
  const [finalOnlyMode, setFinalOnlyMode] = useState(true);
  const [permissionNote, setPermissionNote] = useState("");
  const [toolDraft, setToolDraft] = useState({
    tool: "run_command",
    params: { command: "" },
  });
  const [toolOutput, setToolOutput] = useState("");
  const [attachToolToTask, setAttachToolToTask] = useState(true);
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [editorPath, setEditorPath] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editorMessage, setEditorMessage] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [browserWorking, setBrowserWorking] = useState(false);
  const [explorerRoot, setExplorerRoot] = useState(".");
  const [explorerFilter, setExplorerFilter] = useState("");
  const [explorerEntries, setExplorerEntries] = useState([]);
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [explorerError, setExplorerError] = useState("");
  const [explorerMessage, setExplorerMessage] = useState("");
  const [explorerTruncated, setExplorerTruncated] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);

  const tasksRef = useRef(tasks);
  const sharedMessagesRef = useRef(sharedMessages);
  const pendingApprovalsRef = useRef(pendingApprovals);
  const messageScrollRef = useRef(null);
  const chatInputRef = useRef(null);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    sharedMessagesRef.current = sharedMessages;
  }, [sharedMessages]);

  useEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
  }, [pendingApprovals]);

  useEffect(() => {
    if (tasks.length === 0) {
      const nextTask = createTask(taskCounter.current++);
      setTasks([nextTask]);
      setActiveTaskId(nextTask.id);
    } else if (!tasks.find((task) => task.id === activeTaskId)) {
      setActiveTaskId(tasks[0].id);
    }
  }, [tasks, activeTaskId]);

  useEffect(() => {
    handleExplorerRefresh();
  }, []);

  useEffect(() => {
    const handler = (event) => {
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.isComposing
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", handler, true);
    };
  }, []);

  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0];

  useEffect(() => {
    const container = messageScrollRef.current;
    if (!container) {
      return;
    }
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceToBottom < 120) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, [activeTaskId, activeTask?.messages?.length]);

  const updateTask = (taskId, updater) => {
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? updater(task) : task)),
    );
  };

  const patchTask = (taskId, patch) => {
    updateTask(taskId, (task) => ({ ...task, ...patch }));
  };

  const appendTaskMessage = (taskId, message) => {
    updateTask(taskId, (task) => ({
      ...task,
      messages: [...task.messages, message],
    }));
  };

  const buildPrompt = (task, content) => {
    const label = task.title?.trim();
    return label ? `[Task: ${label}]\n${content}` : content;
  };

  const getContextFiles = (task) => {
    const manual = normalizeContextFiles(task?.contextInput ?? "");
    const combined = [...selectedFiles, ...manual];
    return Array.from(new Set(combined));
  };

  const getPermissionForTool = (toolName) => {
    const basePermission = permissionPolicy[toolName] ?? "ask";
    if (basePermission === "deny") {
      return "deny";
    }
    if (noLookMode) {
      return "allow";
    }
    return basePermission;
  };

  const requestApproval = (approval) => {
    setPendingApprovals((prev) => [...prev, approval]);
    setPermissionNote("");
    return true;
  };

  const executeTool = async (toolCall) => {
    const response = await fetch(`${API_BASE_URL}/execute_tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toolCall),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.detail || body.error || "ツール実行に失敗しました");
    }
    return body.result ?? "（結果なし）";
  };

  const sendChatRequest = async (taskId, content, contextFiles) => {
    const task = tasksRef.current.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("タスクが見つかりませんでした");
    }

    const userMessage = { role: "user", content };
    const baseMessages = sharedThread ? sharedMessagesRef.current : task.messages;
    const outgoing = [...baseMessages, userMessage];

    if (sharedThread) {
      setSharedMessages(outgoing);
    }
    appendTaskMessage(taskId, userMessage);

    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: systemPrompt }, ...outgoing],
        context_files: contextFiles,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.detail || body.error || "バックエンドに接続できませんでした");
    }

    const assistantMessage = {
      role: body.role || "assistant",
      content: body.content || "（空の応答）",
    };

    appendTaskMessage(taskId, assistantMessage);
    if (sharedThread) {
      setSharedMessages((prev) => [...prev, assistantMessage]);
    }
    return assistantMessage;
  };

  const handleAssistantResponse = async (taskId, assistantMessage) => {
    const content = assistantMessage?.content ?? "";
    const toolCall = extractToolCall(content);
    if (toolCall) {
      patchTask(taskId, { pendingToolCall: toolCall, status: "awaiting", error: "" });
      const shouldAutoRun = autoRunTools || autoContinue || toolCall.tool === "web_search";
      if (shouldAutoRun) {
        await executeToolCall(taskId, toolCall);
      }
      return;
    }
    if (autoContinue && !DONE_MARKER.test(content)) {
      const task = tasksRef.current.find((entry) => entry.id === taskId);
      const nextStep = (task?.stepCount ?? 0) + 1;
      const stepLimit = Math.max(1, Number(maxSteps) || 1);
      if (nextStep <= stepLimit) {
        patchTask(taskId, { stepCount: nextStep, status: "running" });
        const followup = [
          "Continue the task.",
          'If you are fully done, reply with "DONE:" and the final answer.',
        ].join("\n");
        const assistantReply = await sendChatRequest(
          taskId,
          followup,
          getContextFiles(task),
        );
        await handleAssistantResponse(taskId, assistantReply);
        return;
      }
    }
    patchTask(taskId, { status: "done" });
  };

  const executeToolCall = async (taskId, toolCall, options = {}) => {
    const permission = getPermissionForTool(toolCall.tool);
    const isWebSearch = toolCall.tool === "web_search";
    if (!options.skipApproval) {
      if (permission === "deny") {
        patchTask(taskId, {
          status: "failed",
          error: `権限ポリシーで拒否されました: ${toolCall.tool}`,
          pendingToolCall: null,
        });
        return;
      }
      if (permission === "ask") {
        const requested = requestApproval({
          id: createId(),
          toolCall,
          taskId,
          source: options.source ?? "agent",
          createdAt: Date.now(),
        });
        if (requested) {
          patchTask(taskId, { status: "awaiting" });
        }
        return;
      }
    }

    patchTask(taskId, { status: "running", error: "" });
    if (isWebSearch) {
      setBrowserWorking(true);
    }
    try {
      const result = await executeTool(toolCall);
      const toolMessage = {
        role: "tool",
        content: result,
        tool: toolCall.tool,
        params: toolCall.params,
      };
      appendTaskMessage(taskId, toolMessage);
      patchTask(taskId, { pendingToolCall: null });

      if (autoContinue) {
        const task = tasksRef.current.find((entry) => entry.id === taskId);
        const nextStep = (task?.stepCount ?? 0) + 1;
        const stepLimit = Math.max(1, Number(maxSteps) || 1);
        patchTask(taskId, { stepCount: nextStep });
        if (nextStep <= stepLimit) {
          const followup = `Tool result (${toolCall.tool}):\n${result}\n\nContinue the task.`;
          const assistantMessage = await sendChatRequest(
            taskId,
            followup,
            getContextFiles(task),
          );
          await handleAssistantResponse(taskId, assistantMessage);
          return;
        }
      }

      patchTask(taskId, { status: "done" });
    } catch (error) {
      patchTask(taskId, {
        status: "failed",
        error: error?.message ?? "ツール実行に失敗しました",
      });
    } finally {
      if (isWebSearch) {
        setBrowserWorking(false);
      }
    }
  };

  const runTask = async (taskId) => {
    const task = tasksRef.current.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }

    const trimmed = task.prompt.trim();
    if (!trimmed) {
      patchTask(taskId, { status: "failed", error: "プロンプトを入力してください。" });
      return;
    }

    patchTask(taskId, {
      status: "running",
      error: "",
      pendingToolCall: null,
      stepCount: 0,
    });

    try {
      const promptContent = buildPrompt(task, trimmed);
      const assistantMessage = await sendChatRequest(
        taskId,
        promptContent,
        getContextFiles(task),
      );
      await handleAssistantResponse(taskId, assistantMessage);
    } catch (error) {
      patchTask(taskId, {
        status: "failed",
        error: error?.message ?? "不明なエラーが発生しました",
      });
    }
  };

  const handleChatSend = async () => {
    if (!activeTask) {
      return;
    }
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }
    setChatSending(true);
    setChatInput("");
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
    patchTask(activeTask.id, {
      status: "running",
      error: "",
      pendingToolCall: null,
      stepCount: 0,
    });
    try {
      const assistantMessage = await sendChatRequest(
        activeTask.id,
        trimmed,
        getContextFiles(activeTask),
      );
      await handleAssistantResponse(activeTask.id, assistantMessage);
    } catch (error) {
      setChatInput(trimmed);
      patchTask(activeTask.id, {
        status: "failed",
        error: error?.message ?? "不明なエラーが発生しました",
      });
    } finally {
      setChatSending(false);
    }
  };

  const runAllTasks = async () => {
    setRunAllInProgress(true);
    for (const task of tasksRef.current) {
      if (task.prompt.trim()) {
        await runTask(task.id);
      }
    }
    setRunAllInProgress(false);
  };

  const addTask = () => {
    const newTask = createTask(taskCounter.current++);
    setTasks((prev) => [...prev, newTask]);
    setActiveTaskId(newTask.id);
  };

  const removeTask = (taskId) => {
    if (tasksRef.current.length <= 1) {
      return;
    }
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
  };

  const resetTask = (taskId) => {
    patchTask(taskId, {
      prompt: "",
      contextInput: "",
      status: "idle",
      messages: [],
      pendingToolCall: null,
      error: "",
      stepCount: 0,
    });
  };

  const dismissPendingTool = (task) => {
    if (!task?.pendingToolCall) {
      return;
    }
    removeApprovalsForTaskTool(task.id, task.pendingToolCall.tool);
    patchTask(task.id, { pendingToolCall: null, status: "done" });
  };

  const insertTemplate = (taskId) => {
    updateTask(taskId, (task) => {
      const nextPrompt = task.prompt.trim()
        ? `${task.prompt.trim()}\n\n${PROMPT_TEMPLATE}`
        : PROMPT_TEMPLATE;
      return { ...task, prompt: nextPrompt };
    });
  };

  const handleToolChange = (event) => {
    const tool = event.target.value;
    setToolDraft({ tool, params: { ...TOOL_PRESETS[tool] } });
    setToolOutput("");
  };

  const handleToolParamChange = (key, value) => {
    setToolDraft((prev) => ({
      ...prev,
      params: { ...prev.params, [key]: value },
    }));
  };

  const executeToolForConsole = async (toolCall) => {
    setToolOutput("");
    const isWebSearch = toolCall.tool === "web_search";
    if (isWebSearch) {
      setBrowserWorking(true);
    }
    try {
      const result = await executeTool(toolCall);
      setToolOutput(result);
      if (attachToolToTask && activeTask) {
        appendTaskMessage(activeTask.id, {
          role: "tool",
          content: result,
          tool: toolCall.tool,
          params: toolCall.params,
        });
      }
    } catch (error) {
      setToolOutput(error?.message ?? "ツール実行に失敗しました");
    } finally {
      if (isWebSearch) {
        setBrowserWorking(false);
      }
    }
  };

  const handleToolRun = async () => {
    const permission = getPermissionForTool(toolDraft.tool);
    if (permission === "deny") {
      setToolOutput("権限ポリシーで拒否されています。");
      return;
    }
    if (permission === "ask") {
      const requested = requestApproval({
        id: createId(),
        toolCall: toolDraft,
        taskId: attachToolToTask ? activeTask?.id ?? null : null,
        source: "console",
        createdAt: Date.now(),
      });
      if (requested) {
        setToolOutput("承認待ちです。Permissionsで許可してください。");
      }
      return;
    }
    await executeToolForConsole(toolDraft);
  };

  const performExplorerList = async (toolCall) => {
    setExplorerLoading(true);
    setExplorerError("");
    setExplorerMessage("");
    try {
      const result = await executeTool(toolCall);
      if (
        result.startsWith("Error:") ||
        result.startsWith("System Error:")
      ) {
        setExplorerEntries([]);
        setExplorerTruncated(false);
        setExplorerError(result);
        return;
      }
      const parsed = parseListFilesResult(result);
      setExplorerEntries(parsed.entries);
      setExplorerTruncated(parsed.truncated);
    } catch (error) {
      setExplorerError(error?.message ?? "ファイル一覧の取得に失敗しました");
    } finally {
      setExplorerLoading(false);
    }
  };

  const handleExplorerRefresh = async () => {
    const path = normalizeExplorerRoot(explorerRoot);
    setExplorerError("");
    setExplorerMessage("");
    const toolCall = { tool: "list_files", params: { path } };
    const permission = getPermissionForTool(toolCall.tool);
    if (permission === "deny") {
      setExplorerError("権限ポリシーで拒否されています。");
      return;
    }
    if (permission === "ask") {
      requestApproval({
        id: createId(),
        toolCall,
        taskId: activeTask?.id ?? null,
        source: "explorer_list",
        createdAt: Date.now(),
      });
      setExplorerMessage("承認待ちです。Configで許可してください。");
      return;
    }
    await performExplorerList(toolCall);
  };

  const toggleSelectedFile = (path) => {
    setSelectedFiles((prev) =>
      prev.includes(path)
        ? prev.filter((entry) => entry !== path)
        : [...prev, path],
    );
  };

  const clearSelectedFiles = () => {
    setSelectedFiles([]);
  };

  const performEditorRead = async (toolCall) => {
    setEditorMessage("");
    try {
      const result = await executeTool(toolCall);
      setEditorContent(result);
      setEditorDirty(false);
      setEditorMessage("読み込み完了");
    } catch (error) {
      setEditorMessage(error?.message ?? "読み込みに失敗しました");
    }
  };

  const performEditorWrite = async (toolCall) => {
    setEditorMessage("");
    try {
      const result = await executeTool(toolCall);
      setEditorDirty(false);
      setEditorMessage(result);
    } catch (error) {
      setEditorMessage(error?.message ?? "保存に失敗しました");
    }
  };

  const handleEditorLoad = async () => {
    const path = editorPath.trim();
    if (!path) {
      setEditorMessage("ファイルパスを入力してください。");
      return;
    }
    const toolCall = { tool: "read_file", params: { file_path: path } };
    const permission = getPermissionForTool(toolCall.tool);
    if (permission === "deny") {
      setEditorMessage("権限ポリシーで拒否されています。");
      return;
    }
    if (permission === "ask") {
      requestApproval({
        id: createId(),
        toolCall,
        taskId: activeTask?.id ?? null,
        source: "editor_read",
        createdAt: Date.now(),
      });
      setEditorMessage("承認待ちです。Permissionsで許可してください。");
      return;
    }
    await performEditorRead(toolCall);
  };

  const handleEditorSave = async () => {
    const path = editorPath.trim();
    if (!path) {
      setEditorMessage("ファイルパスを入力してください。");
      return;
    }
    const toolCall = {
      tool: "write_file",
      params: { file_path: path, content: editorContent },
    };
    const permission = getPermissionForTool(toolCall.tool);
    if (permission === "deny") {
      setEditorMessage("権限ポリシーで拒否されています。");
      return;
    }
    if (permission === "ask") {
      requestApproval({
        id: createId(),
        toolCall,
        taskId: activeTask?.id ?? null,
        source: "editor_write",
        createdAt: Date.now(),
      });
      setEditorMessage("承認待ちです。Permissionsで許可してください。");
      return;
    }
    await performEditorWrite(toolCall);
  };

  const removeApprovalById = (approvalId) => {
    setPendingApprovals((prev) =>
      prev.filter((entry) => entry.id !== approvalId),
    );
  };

  const removeApprovalsForTaskTool = (taskId, toolName) => {
    setPendingApprovals((prev) =>
      prev.filter(
        (entry) =>
          !(entry.taskId === taskId && entry.toolCall.tool === toolName),
      ),
    );
  };

  const resolveSingleApproval = async (approval, action) => {
    if (!approval) {
      return;
    }

    setPermissionNote("");
    removeApprovalById(approval.id);

    if (action === "allow_always") {
      setPermissionPolicy((prev) => ({
        ...prev,
        [approval.toolCall.tool]: "allow",
      }));
    }

    if (action === "deny_always") {
      setPermissionPolicy((prev) => ({
        ...prev,
        [approval.toolCall.tool]: "deny",
      }));
    }

    const isDenied = action === "deny_once" || action === "deny_always";

    if (isDenied) {
      if (approval.source === "console") {
        setToolOutput("権限で拒否されました。");
      }
      if (approval.source === "editor_read" || approval.source === "editor_write") {
        setEditorMessage("権限で拒否されました。");
      }
      if (approval.taskId) {
        patchTask(approval.taskId, {
          status: "failed",
          error: `権限で拒否されました: ${approval.toolCall.tool}`,
          pendingToolCall: null,
        });
      }
      return;
    }

    if (approval.source === "console") {
      await executeToolForConsole(approval.toolCall);
      return;
    }

    if (approval.source === "editor_read") {
      await performEditorRead(approval.toolCall);
      return;
    }

    if (approval.source === "editor_write") {
      await performEditorWrite(approval.toolCall);
      return;
    }

    if (approval.source === "explorer_list") {
      await performExplorerList(approval.toolCall);
      return;
    }

    if (approval.taskId) {
      await executeToolCall(approval.taskId, approval.toolCall, {
        skipApproval: true,
        source: approval.source,
      });
    }
  };

  const resolveApprovalById = async (approvalId, action) => {
    const approval = pendingApprovalsRef.current.find(
      (entry) => entry.id === approvalId,
    );
    if (!approval) {
      return;
    }
    await resolveSingleApproval(approval, action);
  };

  const resolveAllApprovals = async (action) => {
    const approvals = [...pendingApprovalsRef.current];
    for (const approval of approvals) {
      await resolveSingleApproval(approval, action);
    }
  };

  const handleNoLookToggle = async (checked) => {
    setNoLookMode(checked);
    if (checked && pendingApprovalsRef.current.length) {
      await resolveAllApprovals("allow_once");
    }
  };

  const setAllPermissions = (value) => {
    setPermissionPolicy((prev) => {
      const nextPolicy = { ...prev };
      Object.keys(TOOL_LABELS).forEach((tool) => {
        nextPolicy[tool] = value;
      });
      return nextPolicy;
    });
  };

  const statusInfo = STATUS_CONFIG[activeTask?.status ?? "idle"] ?? STATUS_CONFIG.idle;
  const contextFiles = getContextFiles(activeTask);
  const activeApproval = pendingApprovals[0] ?? null;
  const pendingApprovalCount = pendingApprovals.length;
  const approvalQueuePreview = pendingApprovals.slice(0, 4);
  const pendingToolPermission = activeTask?.pendingToolCall
    ? getPermissionForTool(activeTask.pendingToolCall.tool)
    : null;
  const approvalTask = activeApproval?.taskId
    ? tasks.find((task) => task.id === activeApproval.taskId)
    : null;
  const approvalSourceLabel = activeApproval
    ? APPROVAL_SOURCES[activeApproval.source] ?? activeApproval.source
    : null;
  const approvalCommandRisk =
    activeApproval?.toolCall?.tool === "run_command"
      ? getRunCommandRisk(activeApproval.toolCall.params?.command ?? "")
      : null;
  const approvalPath =
    activeApproval?.toolCall?.tool === "read_file" ||
    activeApproval?.toolCall?.tool === "write_file"
      ? activeApproval.toolCall.params?.file_path ?? ""
      : "";
  const approvalPathRisk = approvalPath ? getPathRisk(approvalPath) : null;
  const editorPathRisk = editorPath ? getPathRisk(editorPath) : null;
  const explorerQuery = explorerFilter.trim().toLowerCase();
  const filteredExplorerEntries = explorerEntries.filter((entry) =>
    entry.toLowerCase().includes(explorerQuery),
  );
  const chatBusy =
    activeTask?.status === "running" ||
    activeTask?.status === "awaiting" ||
    chatSending;
  const browserMessages =
    activeTask?.messages?.filter(
      (message) => message.role === "tool" && message.tool === "web_search",
    ) ?? [];
  const browserPreview = browserMessages.slice(-3);
  const browserBusy =
    browserWorking ||
    activeTask?.pendingToolCall?.tool === "web_search" ||
    chatBusy;
  const browserStatus = browserWorking
    ? {
        label: "Searching",
        tone: "text-[#f6c744]",
        dot: "bg-[#f6c744]",
      }
    : activeTask?.pendingToolCall?.tool === "web_search"
      ? {
          label: "Queued",
          tone: "text-[#f6c744]",
          dot: "bg-[#f6c744]",
        }
      : chatBusy
        ? {
            label: "Thinking",
            tone: "text-[#5eead4]",
            dot: "bg-[#5eead4]",
          }
        : {
            label: "Idle",
            tone: "text-[var(--vscode-muted)]",
            dot: "bg-[var(--vscode-border)]",
          };
  const rawMessages = activeTask?.messages ?? [];
  const assistantMessages = rawMessages.filter(
    (message) => message.role === "assistant",
  );
  const lastDoneMessage = [...assistantMessages]
    .reverse()
    .find((message) => DONE_MARKER.test(message.content ?? ""));
  const lastAssistantMessage =
    lastDoneMessage ?? [...assistantMessages].reverse()[0] ?? null;
  const displayMessages = finalOnlyMode
    ? [
        ...rawMessages.filter((message) => message.role === "user"),
        ...(lastAssistantMessage ? [lastAssistantMessage] : []),
      ]
    : rawMessages;
  const isApprovalForActiveTask =
    activeTask?.pendingToolCall &&
    pendingApprovals.some(
      (entry) =>
        entry.taskId === activeTask.id &&
        entry.toolCall.tool === activeTask.pendingToolCall.tool,
    );

  return (
    <div className="ui-root h-screen bg-[var(--vscode-bg)] text-[var(--vscode-text)]">
      <div className="app-shell flex h-full flex-col gap-4 p-4">
        <header className="ui-header flex min-h-[3rem] flex-wrap items-center justify-between gap-3 px-4 py-2 text-[11px] text-[var(--vscode-muted)]">
          <div className="flex items-center gap-3">
            <span className="ui-dot" />
            <span className="text-[13px] font-semibold tracking-[0.08em] text-[var(--vscode-text)]">
              Local Code Agent
            </span>
            <span className="ui-chip text-[9px] uppercase tracking-[0.35em] text-[var(--vscode-muted)]">
              Studio Mode
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em]">
            <span className="ui-chip text-[9px]">Backend {API_BASE_URL}</span>
            <span className="ui-chip text-[9px] text-[var(--vscode-text)]">
              {runAllInProgress ? "Running" : "Ready"}
            </span>
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
          <aside className="ui-rail flex w-full items-center gap-2 px-2 py-2 text-[10px] lg:w-14 lg:flex-col lg:py-4">
            {ACTIVITY_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => setActiveView(item.id)}
                className={`flex h-9 w-12 items-center justify-center rounded-xl border-b-2 transition lg:mb-2 lg:h-12 lg:w-full lg:border-b-0 lg:border-l-2 ${
                  item.id === activeView
                    ? "border-[var(--vscode-accent)] bg-white/15 text-white shadow-sm"
                    : "border-transparent text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <span className="text-[10px] font-semibold tracking-[0.2em]">
                  {item.glyph}
                </span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-[10px] text-white/80 lg:ml-0 lg:mt-auto lg:flex-col lg:gap-2 lg:pb-2">
              <span className="ui-chip ui-chip--dark px-2 py-1 text-[10px]">
                {pendingApprovalCount}
              </span>
              <span className="text-[9px] uppercase tracking-[0.3em]">Queue</span>
            </div>
          </aside>

          {activeView === "workspace" ? (
            <div className="flex flex-1 flex-col gap-4 lg:flex-row">
              <aside className="ui-panel flex w-full flex-shrink-0 flex-col overflow-hidden border border-[var(--vscode-border)] bg-[var(--vscode-sidebar)] text-[11px] text-[var(--vscode-muted)] lg:w-80">
                <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-[0.2em]">
                  <span className="text-[var(--vscode-text)]">File System</span>
                  <button
                    type="button"
                    onClick={handleExplorerRefresh}
                    className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                  >
                    Refresh
                  </button>
                </div>

                <div className="space-y-2 px-3 pb-3">
                  <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                    Root
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={explorerRoot}
                      onChange={(event) => setExplorerRoot(event.target.value)}
                      className={`flex-1 ${INPUT_SM}`}
                    />
                    <button
                      type="button"
                      onClick={handleExplorerRefresh}
                      className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                    >
                      Load
                    </button>
                  </div>

                  <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                    Filter
                  </label>
                  <input
                    value={explorerFilter}
                    onChange={(event) => setExplorerFilter(event.target.value)}
                    className={`w-full ${INPUT_SM}`}
                  />
                  <div className="flex items-center justify-between text-[10px] text-[var(--vscode-muted)]">
                    <span>Selected {selectedFiles.length}</span>
                    <button
                      type="button"
                      onClick={clearSelectedFiles}
                      disabled={!selectedFiles.length}
                      className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] disabled:text-[var(--vscode-muted)]"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {explorerMessage && (
                  <div className="mx-3 rounded-2xl border border-[#f0c674] bg-[rgba(255,204,0,0.12)] px-3 py-2 text-[11px] text-[#b45309]">
                    {explorerMessage}
                  </div>
                )}

                {explorerError && (
                  <div className="mx-3 rounded-2xl border border-[#f44747] bg-[rgba(244,71,71,0.12)] px-3 py-2 text-[11px] text-[#b91c1c]">
                    {explorerError}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-2 pb-3">
                  {explorerLoading ? (
                    <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-4 text-[11px] text-[var(--vscode-muted)]">
                      読み込み中...
                    </div>
                  ) : filteredExplorerEntries.length ? (
                    <div className="ui-stagger space-y-1">
                      {filteredExplorerEntries.map((entry) => (
                        <label
                          key={entry}
                          className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1 transition hover:translate-x-0.5 hover:bg-white/70"
                        >
                          <input
                            type="checkbox"
                            checked={selectedFiles.includes(entry)}
                            onChange={() => toggleSelectedFile(entry)}
                          />
                          <span className="truncate text-[11px] text-[var(--vscode-text)]">
                            {formatExplorerEntry(entry, explorerRoot)}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-4 text-[11px] text-[var(--vscode-muted)]">
                      ファイルが見つかりません。
                    </div>
                  )}
                </div>

                {explorerTruncated && (
                  <div className="px-3 pb-3 text-[10px] text-[var(--vscode-muted)]">
                    結果が多いため一部のみ表示しています。
                  </div>
                )}
              </aside>

              <main className="ui-panel flex flex-1 flex-col overflow-hidden border border-[var(--vscode-border)] bg-[var(--vscode-editor)]">
                <div className="flex h-10 items-center gap-2 border-b border-[var(--vscode-border)] bg-[var(--vscode-tabbar)] px-3 text-[11px] text-[var(--vscode-text)]">
                  <span className="rounded-full border border-[var(--vscode-border)] bg-white/70 px-3 py-1 text-[11px]">
                    Chat
                  </span>
                  <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                    <span>Active</span>
                    <span className="text-[var(--vscode-text)]">
                      {activeTask?.title || "Untitled Task"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveView("config")}
                      className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                    >
                      Config
                    </button>
                  </div>
                </div>

                <div className="flex flex-1 flex-col overflow-hidden p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                        Conversation
                      </p>
                      <h2 className="text-lg text-[var(--vscode-text)]">
                        {activeTask?.title || "Conversation"}
                      </h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] ${statusInfo.className}`}
                      >
                        {statusInfo.label}
                      </span>
                      {activeTask?.pendingToolCall && (
                        <span className="rounded-full bg-[rgba(255,204,0,0.18)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b45309]">
                          Tool Pending
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => activeTask && resetTask(activeTask.id)}
                        className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                      >
                        New Chat
                      </button>
                    </div>
                  </div>

                  {pendingApprovalCount > 0 && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#f0c674] bg-[rgba(255,204,0,0.12)] px-3 py-2 text-[11px] text-[#b45309]">
                      <span>承認待ちが {pendingApprovalCount} 件あります。</span>
                      <button
                        type="button"
                        onClick={() => setActiveView("config")}
                        className="rounded-full border border-[#f0c674] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b45309]"
                      >
                        Review
                      </button>
                    </div>
                  )}

                  {activeTask?.pendingToolCall && (
                    <div className="mt-3 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel)] px-3 py-2 text-[11px] text-[var(--vscode-muted)]">
                      ツール提案があります。Configで実行または拒否できます。
                    </div>
                  )}

                  {activeTask?.error && (
                    <div className="mt-3 rounded-2xl border border-[#f44747] bg-[rgba(244,71,71,0.12)] px-3 py-2 text-[12px] text-[#b91c1c]">
                      {activeTask.error}
                    </div>
                  )}

                  <div className="mt-3 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel)] px-3 py-2">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                      <span>Browser</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex items-center gap-2 text-[9px] uppercase tracking-[0.2em] ${browserStatus.tone}`}
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${browserStatus.dot} ${
                              browserBusy ? "animate-pulse" : ""
                            }`}
                          />
                          {browserStatus.label}
                        </span>
                        <span className="ui-chip text-[9px] text-[var(--vscode-text)]">
                          {browserMessages.length} results
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                      {browserPreview.length ? (
                        browserPreview.map((message, index) => (
                          <div
                            key={`browser-${index}`}
                            className="ui-message rounded-2xl border border-[var(--vscode-border)] bg-[rgba(15,23,42,0.35)] px-3 py-2"
                          >
                            <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                              Browser · web_search
                            </div>
                            <div className="markdown-body mt-1 text-[11px] text-[var(--vscode-text)]">
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                {String(message.content ?? "")}
                              </ReactMarkdown>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-3 text-[10px] text-[var(--vscode-muted)]">
                          まだブラウザ結果がありません。
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    ref={messageScrollRef}
                    className="ui-stagger mt-3 flex-1 space-y-2 overflow-y-auto"
                  >
                    {displayMessages.length ? (
                      displayMessages.map((message, index) => {
                        const roleLabel = ROLE_LABELS[message.role] ?? message.role;
                        const messageContent =
                          message.role === "assistant"
                            ? stripDoneMarker(String(message.content ?? ""))
                            : String(message.content ?? "");
                        const messageBorder =
                          message.role === "user"
                            ? "border-[#007acc]"
                            : message.role === "tool"
                              ? "border-[#f59e0b]"
                              : "border-[#4ec9b0]";
                        const messageSurface =
                          message.role === "user"
                            ? "bg-[rgba(255,107,53,0.08)]"
                            : message.role === "tool"
                              ? "bg-[rgba(15,23,42,0.06)]"
                              : "bg-[rgba(18,180,167,0.08)]";
                        return (
                          <div
                            key={`${message.role}-${index}`}
                            className={`ui-message rounded-2xl border border-l-4 ${messageBorder} ${messageSurface} border-[var(--vscode-border)] px-3 py-2`}
                          >
                            <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                              {roleLabel}
                              {message.tool ? ` · ${message.tool}` : ""}
                            </div>
                            <div
                              className={`markdown-body mt-1 text-[11px] text-[var(--vscode-text)] ${
                                message.role === "user" ? "markdown-body--user" : ""
                              }`}
                            >
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                {messageContent}
                              </ReactMarkdown>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-4 text-[11px] text-[var(--vscode-muted)]">
                        チャットを開始してください。
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-[var(--vscode-border)] bg-[var(--vscode-panel)] p-3">
                  {contextFiles.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2 text-[10px] text-[var(--vscode-muted)]">
                      {contextFiles.map((file) => (
                        <span
                          key={file}
                          className="ui-chip text-[10px]"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={chatInputRef}
                    data-chat-input="true"
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.ctrlKey || event.metaKey) &&
                        !event.isComposing
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!chatBusy && chatInput.trim()) {
                          handleChatSend();
                        }
                      }
                    }}
                    placeholder="Ask the agent..."
                    rows={4}
                    className={`w-full ${TEXTAREA_MD}`}
                    aria-disabled={chatBusy}
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] text-[var(--vscode-muted)]">
                      {contextFiles.length
                        ? `${contextFiles.length} files attached`
                        : "No context files"}
                      <span className="ml-2">Ctrl+Enter で送信</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleChatSend}
                      disabled={chatBusy || !chatInput.trim()}
                      className="ui-cta rounded-full px-4 py-1 text-[10px] uppercase tracking-[0.2em] disabled:opacity-60"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </main>
            </div>
          ) : (
            <main className="ui-panel flex flex-1 flex-col overflow-hidden border border-[var(--vscode-border)] bg-[var(--vscode-editor)]">
              <div className="flex h-10 items-center gap-2 border-b border-[var(--vscode-border)] bg-[var(--vscode-tabbar)] px-3 text-[11px] text-[var(--vscode-text)]">
                <span className="rounded-full border border-[var(--vscode-border)] bg-white/70 px-3 py-1 text-[11px]">
                  Config
                </span>
                <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                  <span className="ui-chip text-[9px]">
                    Queue {pendingApprovalCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveView("workspace")}
                    className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                  >
                    Back
                  </button>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
                <aside className="ui-panel flex w-full flex-shrink-0 flex-col overflow-hidden border border-[var(--vscode-border)] bg-[var(--vscode-sidebar)] text-[11px] text-[var(--vscode-muted)] lg:w-72">
                  <div className="border-t border-[var(--vscode-border)]">
                    <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                      Tasks
                    </div>
                    <div className="ui-stagger space-y-2 px-2 pb-2">
                      {tasks.map((task) => {
                        const status = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.idle;
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => setActiveTaskId(task.id)}
                            className={`w-full rounded-2xl border px-3 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm ${
                              task.id === activeTask?.id
                                ? "border-[var(--vscode-accent)] bg-[var(--vscode-panel)]"
                                : "border-transparent hover:border-[var(--vscode-border)] hover:bg-[var(--vscode-panel)]"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[12px] text-[var(--vscode-text)]">
                                {task.title || "Untitled Task"}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] ${status.className}`}
                              >
                                {status.label}
                              </span>
                            </div>
                            <p className="mt-1 max-h-8 overflow-hidden text-[10px] text-[var(--vscode-muted)]">
                              {task.prompt.trim() || "タスクの目的や依頼内容を入力"}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 px-3 pb-3">
                      <button
                        type="button"
                        onClick={addTask}
                        className="ui-ghost flex-1 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                      >
                        New Task
                      </button>
                      <button
                        type="button"
                        onClick={runAllTasks}
                        disabled={runAllInProgress}
                        className="ui-cta flex-1 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] disabled:opacity-60"
                      >
                        Run All
                      </button>
                    </div>
                  </div>

                  <details className="border-t border-[var(--vscode-border)] px-3 py-2">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                      Prompt Studio
                    </summary>
                    <textarea
                      value={systemPrompt}
                      onChange={(event) => setSystemPrompt(event.target.value)}
                      rows={6}
                      className={`mt-2 w-full ${TEXTAREA_SM}`}
                    />
                    <button
                      type="button"
                      onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                      className="ui-ghost mt-2 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                    >
                      Reset Prompt
                    </button>
                  </details>
                </aside>

                <section className="flex flex-1 flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                          Task Editor
                        </p>
                        <h2 className="text-lg text-[var(--vscode-text)]">
                          {activeTask?.title || "Untitled Task"}
                        </h2>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] ${statusInfo.className}`}
                        >
                          {statusInfo.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => activeTask && runTask(activeTask.id)}
                          disabled={activeTask?.status === "running"}
                          className="ui-cta rounded-full px-4 py-1 text-[10px] uppercase tracking-[0.2em] disabled:opacity-60"
                        >
                          Run Task
                        </button>
                        <button
                          type="button"
                          onClick={() => activeTask && resetTask(activeTask.id)}
                          className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                        >
                          Reset
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                          Task Title
                        </label>
                        <input
                          value={activeTask?.title ?? ""}
                          onChange={(event) =>
                            activeTask &&
                            patchTask(activeTask.id, { title: event.target.value })
                          }
                          className={`w-full ${INPUT_MD}`}
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                            Prompt
                          </label>
                          <button
                            type="button"
                            onClick={() => activeTask && insertTemplate(activeTask.id)}
                            className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                          >
                            Insert Template
                          </button>
                        </div>
                        <textarea
                          value={activeTask?.prompt ?? ""}
                          onChange={(event) =>
                            activeTask &&
                            patchTask(activeTask.id, { prompt: event.target.value })
                          }
                          placeholder={PROMPT_TEMPLATE}
                          rows={6}
                          className={`w-full ${TEXTAREA_MD}`}
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                          Context Files
                        </label>
                        <textarea
                          value={activeTask?.contextInput ?? ""}
                          onChange={(event) =>
                            activeTask &&
                            patchTask(activeTask.id, { contextInput: event.target.value })
                          }
                          placeholder="backend/main.py frontend/src/App.jsx"
                          rows={2}
                          className={`w-full ${TEXTAREA_MD}`}
                        />
                        <p className="text-[10px] text-[var(--vscode-muted)]">
                          File System の選択は自動で含まれます。
                        </p>
                        {contextFiles.length > 0 && (
                          <div className="flex flex-wrap gap-2 text-[10px] text-[var(--vscode-muted)]">
                            {contextFiles.map((file) => (
                              <span
                                key={file}
                                className="ui-chip text-[10px]"
                              >
                                {file}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="ui-panel space-y-2 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel)] px-3 py-3">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                          Automation
                        </p>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="flex items-center gap-2 text-[11px] text-[var(--vscode-muted)]">
                            <input
                              type="checkbox"
                              checked={sharedThread}
                              onChange={(event) => setSharedThread(event.target.checked)}
                            />
                            Shared thread
                          </label>
                          <label className="flex items-center gap-2 text-[11px] text-[var(--vscode-muted)]">
                            <input
                              type="checkbox"
                              checked={autoContinue}
                              onChange={(event) => setAutoContinue(event.target.checked)}
                            />
                            Auto-continue
                          </label>
                          <label className="flex items-center gap-2 text-[11px] text-[var(--vscode-muted)]">
                            <input
                              type="checkbox"
                              checked={finalOnlyMode}
                              onChange={(event) =>
                                setFinalOnlyMode(event.target.checked)
                              }
                            />
                            Final output only
                          </label>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--vscode-muted)]">
                          <span className="uppercase tracking-[0.2em]">Max Steps</span>
                          <input
                            type="number"
                            min="1"
                            value={maxSteps}
                            onChange={(event) => setMaxSteps(event.target.value)}
                            disabled={!autoContinue}
                            className={`w-20 ${INPUT_SM}`}
                          />
                        </div>
                      </div>

                      {activeTask?.error && (
                        <div className="rounded-2xl border border-[#f44747] bg-[rgba(244,71,71,0.12)] px-3 py-2 text-[12px] text-[#b91c1c]">
                          {activeTask.error}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="h-72 border-t border-[var(--vscode-border)] bg-[var(--vscode-panel)]">
                    <div className="flex h-9 items-center border-b border-[var(--vscode-border)] px-2 text-[11px] text-[var(--vscode-muted)]">
                      {PANEL_TABS.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActivePanel(tab.id)}
                          className={`mr-2 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] transition ${
                            activePanel === tab.id
                              ? "bg-white/70 text-[var(--vscode-text)] shadow-sm"
                              : "text-[var(--vscode-muted)] hover:text-[var(--vscode-text)] hover:bg-white/60"
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    <div className="h-[calc(100%-2rem)] overflow-y-auto p-3 text-[11px] text-[var(--vscode-text)]">
                      {activePanel === "tools" && (
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <h3 className="text-[11px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                Tool Suggestion
                              </h3>
                              <label className="flex items-center gap-2 text-[10px] text-[var(--vscode-muted)]">
                                <input
                                  type="checkbox"
                                  checked={autoRunTools}
                                  onChange={(event) =>
                                    setAutoRunTools(event.target.checked)
                                  }
                                />
                                Auto-run
                              </label>
                            </div>

                            {activeTask?.pendingToolCall ? (
                              <div className="ui-panel space-y-3 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-3 py-2">
                                <div className="flex items-center justify-between">
                                  <span className="text-[12px] font-semibold text-[var(--vscode-text)]">
                                    {activeTask.pendingToolCall.tool}
                                  </span>
                                  {pendingToolPermission === "deny" ? (
                                    <span className="rounded-full bg-[rgba(244,71,71,0.2)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b91c1c]">
                                      Blocked
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        executeToolCall(
                                          activeTask.id,
                                          activeTask.pendingToolCall,
                                        )
                                      }
                                      disabled={isApprovalForActiveTask}
                                      className="ui-cta rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em] disabled:opacity-60"
                                    >
                                      {isApprovalForActiveTask ? "Awaiting" : "Run"}
                                    </button>
                                  )}
                                </div>
                                {pendingToolPermission === "ask" && (
                                  <p className="text-[10px] text-[var(--vscode-muted)]">
                                    権限ポリシーは Ask です。Permissionsで承認してください。
                                  </p>
                                )}
                                {pendingToolPermission === "deny" && (
                                  <p className="text-[10px] text-[#f44747]">
                                    権限ポリシーで拒否されています。
                                  </p>
                                )}
                                <pre className="rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-editor)] px-3 py-2 text-[10px] text-[var(--vscode-text)]">
{JSON.stringify(activeTask.pendingToolCall.params, null, 2)}
                                </pre>
                                <button
                                  type="button"
                                  onClick={() => dismissPendingTool(activeTask)}
                                  className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Dismiss
                                </button>
                              </div>
                            ) : (
                              <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-3 text-[11px] text-[var(--vscode-muted)]">
                                ツール提案はありません。
                              </div>
                            )}
                          </div>

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <h3 className="text-[11px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                Tool Console
                              </h3>
                              <label className="flex items-center gap-2 text-[10px] text-[var(--vscode-muted)]">
                                <input
                                  type="checkbox"
                                  checked={attachToolToTask}
                                  onChange={(event) =>
                                    setAttachToolToTask(event.target.checked)
                                  }
                                />
                                Attach to log
                              </label>
                            </div>
                            <div className="ui-panel rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-3 py-3">
                              <div className="space-y-2">
                                <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                  Tool
                                </label>
                                <select
                                  value={toolDraft.tool}
                                  onChange={handleToolChange}
                                  className={`w-full ${INPUT_SM}`}
                                >
                                  {Object.keys(TOOL_LABELS).map((tool) => (
                                    <option key={tool} value={tool}>
                                      {TOOL_LABELS[tool]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="mt-3 space-y-2">
                                {Object.entries(toolDraft.params).map(([key, value]) => (
                                  <div key={key} className="space-y-1">
                                    <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                      {key}
                                    </label>
                                    {key === "content" ? (
                                      <textarea
                                        value={value}
                                        onChange={(event) =>
                                          handleToolParamChange(
                                            key,
                                            event.target.value,
                                          )
                                        }
                                        rows={3}
                                        className={`w-full ${TEXTAREA_COMPACT}`}
                                      />
                                    ) : (
                                      <input
                                        value={value}
                                        onChange={(event) =>
                                          handleToolParamChange(
                                            key,
                                            event.target.value,
                                          )
                                        }
                                        className={`w-full ${INPUT_SM}`}
                                      />
                                    )}
                                  </div>
                                ))}
                              </div>
                              <button
                                type="button"
                                onClick={handleToolRun}
                                className="ui-cta mt-3 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                              >
                                Run Tool
                              </button>
                              {toolOutput && (
                                <pre className="mt-3 max-h-40 overflow-y-auto rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-editor)] px-3 py-2 text-[10px] text-[var(--vscode-text)]">
                                  {toolOutput}
                                </pre>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {activePanel === "permissions" && (
                        <div className="space-y-4">
                          <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                            <label className="flex items-center gap-2 text-[11px] text-[var(--vscode-muted)]">
                              <input
                                type="checkbox"
                                checked={noLookMode}
                                onChange={(event) =>
                                  handleNoLookToggle(event.target.checked)
                                }
                              />
                              No-look mode
                            </label>
                            <span className="ui-chip text-[9px] text-[var(--vscode-text)]">
                              Queue {pendingApprovalCount}
                            </span>
                            <button
                              type="button"
                              onClick={() => resolveAllApprovals("allow_once")}
                              disabled={!pendingApprovalCount}
                              className="ui-ghost rounded-full px-3 py-1 text-[10px] disabled:text-[var(--vscode-muted)]"
                            >
                              Allow All Pending
                            </button>
                            <button
                              type="button"
                              onClick={() => resolveAllApprovals("deny_once")}
                              disabled={!pendingApprovalCount}
                              className="ui-ghost rounded-full px-3 py-1 text-[10px] disabled:text-[var(--vscode-muted)]"
                            >
                              Deny All Pending
                            </button>
                            <button
                              type="button"
                              onClick={() => setAllPermissions("allow")}
                              className="ui-ghost rounded-full px-3 py-1 text-[10px]"
                            >
                              Allow All Tools
                            </button>
                            <button
                              type="button"
                              onClick={() => setAllPermissions("ask")}
                              className="ui-ghost rounded-full px-3 py-1 text-[10px]"
                            >
                              Ask All Tools
                            </button>
                          </div>

                          <div className="grid gap-2 md:grid-cols-2">
                            {Object.keys(TOOL_LABELS).map((tool) => (
                              <div
                                key={tool}
                                className="ui-panel flex items-center justify-between gap-3 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-3 py-2"
                              >
                                <span className="text-[11px] text-[var(--vscode-text)]">
                                  {tool}
                                </span>
                                <select
                                  value={permissionPolicy[tool] ?? "ask"}
                                  onChange={(event) =>
                                    setPermissionPolicy((prev) => ({
                                      ...prev,
                                      [tool]: event.target.value,
                                    }))
                                  }
                                  className={INPUT_SM}
                                >
                                  {PERMISSION_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>

                          {permissionNote && (
                            <div className="rounded-2xl border border-[#f0c674] bg-[rgba(255,204,0,0.12)] px-3 py-2 text-[11px] text-[#b45309]">
                              {permissionNote}
                            </div>
                          )}

                          {activeApproval ? (
                            <div className="ui-panel space-y-2 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-3 py-3">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-[9px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                    Approval Required
                                  </p>
                                  <p className="text-[12px] text-[var(--vscode-text)]">
                                    {activeApproval.toolCall.tool}
                                  </p>
                                  <p className="text-[10px] text-[var(--vscode-muted)]">
                                    Source: {approvalSourceLabel}
                                    {approvalTask ? ` · ${approvalTask.title}` : ""}
                                  </p>
                                </div>
                                <span className="rounded-full bg-[rgba(255,204,0,0.18)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b45309]">
                                  Pending
                                </span>
                              </div>

                              {approvalCommandRisk && (
                                <p
                                  className={`rounded border px-2 py-1 text-[10px] ${
                                    approvalCommandRisk.level === "high"
                                      ? "border-[#f44747] text-[#f44747]"
                                      : "border-[#f0c674] text-[#f0c674]"
                                  }`}
                                >
                                  {approvalCommandRisk.label}
                                </p>
                              )}
                              {approvalPathRisk && (
                                <p className="rounded border border-[#f0c674] px-2 py-1 text-[10px] text-[#f0c674]">
                                  ファイルパスがワークスペース外の可能性があります。
                                </p>
                              )}

                              <pre className="rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-editor)] px-3 py-2 text-[10px] text-[var(--vscode-text)]">
{JSON.stringify(activeApproval.toolCall.params, null, 2)}
                              </pre>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    resolveApprovalById(
                                      activeApproval.id,
                                      "allow_once",
                                    )
                                  }
                                  className="ui-cta rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Allow Once
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    resolveApprovalById(
                                      activeApproval.id,
                                      "allow_always",
                                    )
                                  }
                                  className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Always Allow
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    resolveApprovalById(activeApproval.id, "deny_once")
                                  }
                                  className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Deny Once
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    resolveApprovalById(
                                      activeApproval.id,
                                      "deny_always",
                                    )
                                  }
                                  className="rounded-full border border-[#f44747] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b91c1c]"
                                >
                                  Always Deny
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-3 text-[11px] text-[var(--vscode-muted)]">
                              承認待ちはありません。
                            </div>
                          )}

                          {pendingApprovalCount > 1 && (
                            <div className="space-y-2">
                              <p className="text-[9px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                Queue Preview
                              </p>
                              {approvalQueuePreview.slice(1).map((approval) => (
                                <div
                                  key={approval.id}
                                  className="ui-panel flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-2 py-2 text-[10px]"
                                >
                                  <div className="text-[var(--vscode-muted)]">
                                    <span className="text-[var(--vscode-text)]">
                                      {approval.toolCall.tool}
                                    </span>
                                    <span className="text-[var(--vscode-muted)]"> · </span>
                                    <span>
                                      {APPROVAL_SOURCES[approval.source] ??
                                        approval.source}
                                    </span>
                                    {summarizeApproval(approval) && (
                                      <span className="text-[var(--vscode-muted)]">
                                        {" "}
                                        · {summarizeApproval(approval).slice(0, 48)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        resolveApprovalById(approval.id, "allow_once")
                                      }
                                      className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                    >
                                      Allow
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        resolveApprovalById(approval.id, "deny_once")
                                      }
                                      className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                    >
                                      Deny
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {activePanel === "editor" && (
                        <div>
                          {editorEnabled ? (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                    File Editor
                                  </p>
                                  <p className="text-[11px] text-[var(--vscode-muted)]">
                                    読み書きは権限ポリシーに従います
                                  </p>
                                </div>
                                {editorDirty && (
                                  <span className="rounded-full bg-[rgba(255,204,0,0.18)] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#b45309]">
                                    Unsaved
                                  </span>
                                )}
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vscode-muted)]">
                                  File Path
                                </label>
                                <input
                                  value={editorPath}
                                  onChange={(event) =>
                                    setEditorPath(event.target.value)
                                  }
                                  placeholder="frontend/src/App.jsx"
                                  className={`w-full ${INPUT_SM}`}
                                />
                                {editorPathRisk && (
                                  <p className="rounded border border-[#f0c674] px-2 py-1 text-[10px] text-[#f0c674]">
                                    ワークスペース外のパスの可能性があります。
                                  </p>
                                )}
                              </div>

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={handleEditorLoad}
                                  className="ui-cta rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Load
                                </button>
                                <button
                                  type="button"
                                  onClick={handleEditorSave}
                                  className="ui-ghost rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                                >
                                  Save
                                </button>
                              </div>

                              <textarea
                                value={editorContent}
                                onChange={(event) => {
                                  setEditorContent(event.target.value);
                                  setEditorDirty(true);
                                }}
                                rows={10}
                                className={`w-full ${TEXTAREA_EDITOR}`}
                              />

                              {editorMessage && (
                                <p className="rounded-2xl border border-[var(--vscode-border)] bg-[var(--vscode-panel-alt)] px-2 py-1 text-[10px] text-[var(--vscode-muted)]">
                                  {editorMessage}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[var(--vscode-border)] px-3 py-4 text-[11px] text-[var(--vscode-muted)]">
                              File Editor はオフです。
                              <button
                                type="button"
                                onClick={() => setEditorEnabled(true)}
                                className="ui-ghost ml-3 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]"
                              >
                                Open
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </main>
          )}
        </div>

        <footer className="ui-footer flex min-h-[2.5rem] flex-wrap items-center justify-between gap-2 px-4 text-[10px] uppercase tracking-[0.2em]">
          <div className="flex items-center gap-2">
            <span>Agent</span>
            <span className="ui-chip ui-chip--dark text-[9px]">
              {activeTask?.title || "Untitled Task"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="ui-chip ui-chip--dark text-[9px]">
              Queue {pendingApprovalCount}
            </span>
            <span className="ui-chip ui-chip--dark text-[9px]">
              Steps {activeTask?.stepCount ?? 0}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
