import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API = `${process.env.API_URL || "http://localhost:5000"}/api/students`;
const SECRET = process.env.MCP_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("Set MCP_SECRET to a random string of at least 16 characters");
  process.exit(1);
}

async function call(path = "", options = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000), // the backend may be waking up
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.errors?.join(", ") || body.message || `HTTP ${res.status}`);
  }
  return body;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: err.message }] });
const run = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (e) { return fail(e); }
};

const fields = {
  name: z.string(),
  email: z.string().email().optional(),
  department: z.string(),
  semester: z.number().int().min(1).max(8),
  contact: z.string().regex(/^\d{10}$/).optional(),
};

function buildServer() {
  const server = new McpServer({ name: "student-api", version: "1.0.0" });

  server.registerTool(
    "list_students",
    {
      description: "List all students, optionally filtered by name or student ID text",
      inputSchema: { search: z.string().optional() },
    },
    run(({ search }) => call(search ? `?search=${encodeURIComponent(search)}` : ""))
  );

  server.registerTool(
    "get_student",
    { description: "Get one student by student ID, e.g. ST101", inputSchema: { studentId: z.string() } },
    run(({ studentId }) => call(`/${encodeURIComponent(studentId)}`))
  );

  server.registerTool(
    "add_student",
    { description: "Add a new student", inputSchema: { studentId: z.string(), ...fields } },
    run((args) => call("", { method: "POST", body: JSON.stringify(args) }))
  );

  server.registerTool(
    "update_student",
    {
      description: "Update an existing student. Only the fields provided are changed.",
      inputSchema: { studentId: z.string(), ...z.object(fields).partial().shape },
    },
    run(({ studentId, ...updates }) =>
      call(`/${encodeURIComponent(studentId)}`, { method: "PUT", body: JSON.stringify(updates) })
    )
  );

  server.registerTool(
    "delete_student",
    {
      description: "Permanently delete a student by student ID. This cannot be undone.",
      inputSchema: { studentId: z.string() },
    },
    run(({ studentId }) => call(`/${encodeURIComponent(studentId)}`, { method: "DELETE" }))
  );

  return server;
}

const app = express();
app.use(express.json());

const route = `/mcp/${SECRET}`;

// Stateless: a fresh server and transport for every request
app.post(route, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed = (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get(route, notAllowed);
app.delete(route, notAllowed);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.error(`MCP server listening on port ${PORT}`));