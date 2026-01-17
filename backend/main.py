import os
import subprocess
import glob
import json
import html
import re
import ssl
import urllib.parse
import urllib.request
import urllib.error
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI

# Load env from secrets
load_dotenv(dotenv_path="../secrets/.env")

app = FastAPI(title="Local Code Agent API")

# Allow CORS for the React Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration ---
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:1234/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "llama3")
API_KEY = "dummy" # Local LLMs usually don't need a real key

client = OpenAI(base_url=LLM_BASE_URL, api_key=API_KEY)

# --- Models ---
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    context_files: Optional[List[str]] = []

class ToolCall(BaseModel):
    tool: str
    params: Dict[str, Any]

# --- System Prompts ---
SYSTEM_PROMPT = """
You are a Local Code Agent, a highly skilled software engineer. 
You are running on the user's local machine and have direct access to the file system.

Your goal is to help the user build, debug, and understand code.

You have access to the following tools. To use a tool, you MUST output a JSON block in this EXACT format:

```json
{
  "tool": "tool_name",
  "params": {
    "param1": "value1"
  }
}
```

Available Tools:
1.  `read_file`: Reads the content of a file.
    *   params: `file_path` (string)
2.  `write_file`: Writes content to a file (overwrites).
    *   params: `file_path` (string), `content` (string)
3.  `run_command`: Executes a shell command.
    *   params: `command` (string)
4.  `list_files`: Lists files in a directory.
    *   params: `path` (string)
5.  `web_search`: Searches the web via DuckDuckGo Instant Answer.
    *   params: `query` (string), `max_results` (int, optional)

If you do not need to use a tool, just respond with normal text.
If you use a tool, STOP generating after the JSON block. The system will execute it and give you the result.
Prefer `web_search` when you need fresh or external information.
"""

# --- Helper Functions ---
def clean_search_text(value: Optional[str]) -> str:
    if not value:
        return ""
    text = html.unescape(value)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()

def fetch_url(request: urllib.request.Request) -> str:
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(exc.reason):
            context = ssl._create_unverified_context()
            with urllib.request.urlopen(request, timeout=12, context=context) as response:
                return response.read().decode("utf-8")
        raise

def decode_duckduckgo_redirect(url_value: str) -> str:
    parsed = urllib.parse.urlparse(url_value)
    params = urllib.parse.parse_qs(parsed.query)
    target = params.get("uddg", [url_value])[0]
    return urllib.parse.unquote(target)

def parse_duckduckgo_markdown(payload: str, limit: int) -> List[Dict[str, str]]:
    results = []
    seen_urls = set()
    lines = payload.splitlines()
    start_index = 0
    for idx, line in enumerate(lines):
        if line.strip() == "Markdown Content:":
            start_index = idx + 1
            break
    link_pattern = re.compile(r"^\[(?!\!)(.+?)\]\((http[^)]+)\)")
    for line in lines[start_index:]:
        match = link_pattern.match(line.strip())
        if not match:
            continue
        title, link = match.groups()
        if "duckduckgo.com/l/?" not in link:
            continue
        target = decode_duckduckgo_redirect(link)
        if target in seen_urls:
            continue
        seen_urls.add(target)
        results.append({
            "title": clean_search_text(title) or target,
            "url": target,
            "snippet": "",
        })
        if len(results) >= limit:
            break
    return results

def run_web_search(query: str, max_results: int = 5) -> str:
    if not query:
        return "Error: query is required."

    safe_max = max(1, min(int(max_results), 10))
    params = {
        "q": query,
        "format": "json",
        "no_html": "1",
        "skip_disambig": "1",
        "t": "local-code-agent",
    }
    url = f"https://api.duckduckgo.com/?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "LocalCodeAgent/1.0"})
    payload = fetch_url(request)
    data = json.loads(payload)

    results = []
    seen_urls = set()

    def add_result(title: Optional[str], url_value: Optional[str], snippet: Optional[str]) -> None:
        if not url_value:
            return
        if url_value in seen_urls:
            return
        seen_urls.add(url_value)
        results.append({
            "title": clean_search_text(title) or url_value,
            "url": url_value,
            "snippet": clean_search_text(snippet),
        })

    if data.get("AbstractURL"):
        add_result(
            data.get("Heading") or query,
            data.get("AbstractURL"),
            data.get("AbstractText") or data.get("Abstract"),
        )

    for item in data.get("Results", []):
        add_result(item.get("Text"), item.get("FirstURL"), item.get("Text"))

    def walk_topics(topics: List[Dict[str, Any]]) -> None:
        for topic in topics:
            if "Topics" in topic:
                walk_topics(topic.get("Topics", []))
            else:
                add_result(topic.get("Text"), topic.get("FirstURL"), topic.get("Text"))

    walk_topics(data.get("RelatedTopics", []))

    if not results:
        ddg_url = f"https://r.jina.ai/http://duckduckgo.com/html/?q={urllib.parse.quote_plus(query)}"
        ddg_request = urllib.request.Request(
            ddg_url,
            headers={"User-Agent": "LocalCodeAgent/1.0"},
        )
        ddg_payload = fetch_url(ddg_request)
        results = parse_duckduckgo_markdown(ddg_payload, safe_max)

    if not results:
        return f"No results found for \"{query}\"."

    lines = []
    for item in results[:safe_max]:
        snippet = f" — {item['snippet']}" if item["snippet"] else ""
        lines.append(f"- [{item['title']}]({item['url']}){snippet}")
    return f"Search results for \"{query}\":\n" + "\n".join(lines)

def execute_tool(tool_name: str, params: Dict[str, Any]) -> str:
    try:
        if tool_name == "read_file":
            path = params.get("file_path")
            if not os.path.exists(path):
                return f"Error: File {path} not found."
            with open(path, "r", encoding="utf-8") as f:
                return f.read()

        elif tool_name == "write_file":
            path = params.get("file_path")
            content = params.get("content")
            # Ensure dir exists
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return f"Success: Wrote to {path}"

        elif tool_name == "run_command":
            cmd = params.get("command")
            # Security Note: This is dangerous. In a real app, sandbox this.
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            return f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"

        elif tool_name == "list_files":
            path = params.get("path", ".")
            # glob to avoid massive output
            files = [f for f in glob.glob(f"{path}/**/*", recursive=True) if not f.startswith(".git") and "node_modules" not in f and "__pycache__" not in f]
            return "\n".join(files[:50]) + (f"\n... (truncated)" if len(files) > 50 else "")

        elif tool_name == "web_search":
            query = params.get("query", "").strip()
            max_results = params.get("max_results", 5)
            try:
                max_results = int(max_results)
            except (TypeError, ValueError):
                max_results = 5
            return run_web_search(query, max_results)

        else:
            return f"Error: Unknown tool {tool_name}"
    except Exception as e:
        return f"System Error: {str(e)}"

# --- Endpoints ---

@app.get("/health")
def health():
    return {"status": "ok", "llm": LLM_BASE_URL}

@app.post("/chat")
def chat(request: ChatRequest):
    # 1. Construct messages
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    
    # Add context from files if requested (simplified for now)
    if request.context_files:
        context_str = "Context Files:\n"
        for fpath in request.context_files:
            try:
                with open(fpath, "r") as f:
                    context_str += f"---\n{fpath}\n---\n{f.read()}\n\n"
            except:
                pass
        messages.append({"role": "system", "content": context_str})

    # Add conversation history
    for m in request.messages:
        messages.append({"role": m.role, "content": m.content})

    try:
        # 2. Call LLM
        response = client.chat.completions.create(
            model=LLM_MODEL,
            messages=messages,
            temperature=0.2,
            stream=False 
        )
        
        reply = response.choices[0].message.content
        return {"role": "assistant", "content": reply}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/execute_tool")
def run_tool_endpoint(tool_call: ToolCall):
    result = execute_tool(tool_call.tool, tool_call.params)
    return {"result": result}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
