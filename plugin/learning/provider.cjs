"use strict";

const LEARNING_ASSISTANT_CAPABILITIES = Object.freeze([
  "explain", "translate", "generateQuestions", "generateCards", "summarize",
]);

function requireSourceText(source) {
  const targetText = typeof source?.targetText === "string" ? source.targetText.trim() : "";
  if (!targetText) {
    throw Object.assign(new Error("A captured targetText is required by the deterministic draft provider."), {
      code: "LEARNING_PROVIDER_TARGET_REQUIRED",
    });
  }
  return targetText;
}

function createDeterministicLearningProvider() {
  return Object.freeze({
    id: "deterministic-mock",
    capabilities: LEARNING_ASSISTANT_CAPABILITIES,
    async generateDraft({ source } = {}) {
      const targetText = requireSourceText(source);
      return { status: "draft", prompt: `Recall the meaning of: ${targetText}`, answer: targetText };
    },
    async explain({ source } = {}) {
      const targetText = requireSourceText(source);
      return { status: "draft", text: `Explain this captured text: ${targetText}` };
    },
    async translate({ source, targetLanguage = "English" } = {}) {
      const targetText = requireSourceText(source);
      return { status: "draft", text: `Translate to ${String(targetLanguage)}: ${targetText}` };
    },
    async generateQuestions({ source, count = 3 } = {}) {
      const targetText = requireSourceText(source);
      const questionCount = Number.isSafeInteger(count) ? Math.max(1, Math.min(count, 10)) : 3;
      return {
        status: "draft",
        questions: Array.from({ length: questionCount }, (_, index) => ({
          prompt: index === 0 ? `Recall the meaning of: ${targetText}` : `Question ${index + 1} about: ${targetText}`,
          answer: targetText,
        })),
      };
    },
    async generateCards({ source } = {}) {
      const targetText = requireSourceText(source);
      return { status: "draft", cards: [{ prompt: `Recall the meaning of: ${targetText}`, answer: targetText }] };
    },
    async summarize({ source } = {}) {
      const targetText = requireSourceText(source);
      return { status: "draft", summary: `Captured text: ${targetText}` };
    },
  });
}

async function createDraftWithProvider({ service, provider, source } = {}) {
  if (!service || typeof service.createDraft !== "function") throw new TypeError("A learning service with createDraft() is required.");
  if (!provider || typeof provider.generateDraft !== "function") throw new TypeError("A draft provider with generateDraft() is required.");
  const generated = await provider.generateDraft({ source: source == null ? source : JSON.parse(JSON.stringify(source)) });
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    throw Object.assign(new Error("The draft provider must return prompt and answer text."), { code: "LEARNING_PROVIDER_OUTPUT_INVALID" });
  }
  return service.createDraft({ source, prompt: generated.prompt, answer: generated.answer });
}

module.exports = {
  LEARNING_ASSISTANT_CAPABILITIES,
  createDeterministicLearningProvider,
  createDraftWithProvider,
};
