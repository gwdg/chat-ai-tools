#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile =
  profileIndex >= 0
    ? args[profileIndex + 1]
    : process.env.THUNDERBIRD_PROFILE;
const messageId = args.find(
  (arg, index) =>
    !arg.startsWith("--") && (profileIndex < 0 || index !== profileIndex + 1),
);

if (!profile || !messageId) {
  console.error(
    "usage: node test-client.js --profile <profile-dir> <message-id> [--read|--unread] [--answered]",
  );
  process.exit(1);
}

const command = {
  id: randomUUID(),
  command: "mark",
  messageId: messageId.replace(/^<|>$/g, ""),
};
if (args.includes("--read")) command.read = true;
if (args.includes("--unread")) command.read = false;
if (args.includes("--answered")) command.answered = true;

const base = path.join(profile, "thunderbird-mcp-bridge");
const commands = path.join(base, "commands");
const results = path.join(base, "results");
await fs.mkdir(commands, { recursive: true });
await fs.mkdir(results, { recursive: true });

const commandFile = path.join(commands, `${command.id}.json`);
const temporary = `${commandFile}.tmp`;
await fs.writeFile(temporary, JSON.stringify(command, null, 2));
await fs.rename(temporary, commandFile);

const resultFile = path.join(results, `${command.id}.json`);
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  try {
    const text = await fs.readFile(resultFile, "utf8");
    console.log(text);
    await fs.unlink(resultFile).catch(() => {});
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

await fs.unlink(commandFile).catch(() => {});
console.error(
  "Timed out. Is Thunderbird running with the extension loaded?",
);
process.exit(1);
