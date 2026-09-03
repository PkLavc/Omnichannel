import assert from "node:assert/strict";
import test from "node:test";
import { deterministicSummary, extractConversationState } from "./memory.js";

test("extrai dados sem apagar estado anterior", () => {
  const first = extractConversationState("Meu nome é Ana Silva e meu telefone é (11) 99876-5432");
  const second = extractConversationState("Moro em Campinas. O problema: tela quebrada", first);
  assert.equal(second.telefone, "11998765432");
  assert.equal(second.nome, "Ana Silva");
  assert.equal(second.cidade, "Campinas");
  assert.equal(second.defeito, "tela quebrada");
});

test("não interpreta identificadores e timestamps como telefone", () => {
  const state = extractConversationState("mensagem da conversa conc-1784637966-A");
  assert.equal(state.telefone, undefined);
  assert.equal(extractConversationState("protocolo_5511998765432_teste").telefone, undefined);
  assert.equal(extractConversationState("11998765432").telefone, "11998765432");
});

test("cartão de atendimento acumula CPF, e-mail, serviço, unidade e horário", () => {
  const first = extractConversationState(
    "Meu nome é Maria Silva, CPF 123.456.789-09 e e-mail maria@example.com.",
  );
  const second = extractConversationState(
    "Quero trocar a tela do iPhone 15 Pro na loja Brasília em 30/07/2026 às 14:30.",
    first,
  );

  assert.equal(second.nome, "Maria Silva");
  assert.equal(second.cpf, "12345678909");
  assert.equal(second.email, "maria@example.com");
  assert.equal(second.modelo, "iPhone 15 Pro");
  assert.equal(second.servico, "tela do iPhone 15 Pro");
  assert.equal(second.unidadeDesejada, "Brasília");
  assert.equal(second.dataDesejada, "30/07/2026");
  assert.equal(second.horarioDesejado, "14:30");
});

test("pedido de agendamento separa serviço do modelo", () => {
  const state = extractConversationState(
    "Quero agendar uma troca de tela para meu iPhone 15 Pro.",
  );

  assert.equal(state.servico, "troca de tela");
  assert.equal(state.modelo, "iPhone 15 Pro");
  assert.equal(state.unidadeAgendamento, undefined);
});

test("resumo preserva fatos estruturados", () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: index === 0 ? "Prefiro contato por mensagem" : `Mensagem ${index + 1}`,
  }));
  const summary = deterministicSummary(messages, { modelo: "iPhone 13" });
  assert.match(summary, /modelo: iPhone 13/);
  assert.match(summary, /Prefiro contato por mensagem/);
  assert.match(summary, /Mensagem 40/);
});
