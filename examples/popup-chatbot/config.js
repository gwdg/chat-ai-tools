import { chatConfig } from "../embedded-chatbot/config.js";

export const popupConfig = {
  ...chatConfig,
  popup: true,
  welcome:
    "Hello! I am the popup SAIA assistant. Minimize me with the chat icon in the bottom-right corner.",
};
