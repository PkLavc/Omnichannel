import { createServer } from "node:http";

createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/key") return response.end(JSON.stringify({ data: { label: "e2e" } }));
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      const input = JSON.parse(body);
      const system = input.messages.find(message => message.role === "system")?.content || "";
      response.end(JSON.stringify({
        choices: [{ message: { content: `Resposta E2E confirmada para: ${input.messages.at(-1)?.content} [RAG:${system.includes("Base da empresa:") ? "consultado" : "sem resultado"}]` } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, cost: 0.00002 },
      }));
    });
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: "not found" } }));
}).listen(8080, "0.0.0.0");
