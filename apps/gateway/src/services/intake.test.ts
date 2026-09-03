import assert from "node:assert/strict";
import test from "node:test";
import { proactiveIntakeAnswer } from "./intake.js";

test("loja mais próxima exige localização antes de recomendar", () => {
  assert.match(proactiveIntakeAnswer("Qual a loja mais perto?", {}, 2) ?? "", /bairro, cidade, CEP ou endereço/i);
  assert.equal(proactiveIntakeAnswer("Qual a loja mais perto?", { cidade: "Niterói" }, 2), undefined);
});

test("problema genérico de tela exige modelo e sintomas antes de orçamento", () => {
  assert.match(proactiveIntakeAnswer("Deu problema na tela", {}, 2) ?? "", /qual é o aparelho e modelo/i);
  assert.match(proactiveIntakeAnswer("Deu problema na tela", { modelo: "iPhone 13" }, 2) ?? "", /o que exatamente acontece/i);
  assert.equal(
    proactiveIntakeAnswer("A tela do iPhone 13 está quebrada e sem imagem", { modelo: "iPhone 13" }, 2),
    undefined,
  );
});

test("abertura vaga apresenta opções de atendimento", () => {
  assert.match(
    proactiveIntakeAnswer("Olá", {}, 1) ?? "",
    /manutenção.*compra ou venda.*acessórios.*lojas.*agendamentos/i,
  );
});
