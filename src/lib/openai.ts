import OpenAI from "openai";

let _client: OpenAI | null = null;

export function openai(): OpenAI {
  if (_client) return _client;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  _client = new OpenAI();
  return _client;
}
