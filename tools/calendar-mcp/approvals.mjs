import { confirmCalendarChange } from "./dialog.mjs";

export class ActionApprovals {
  constructor({ dialog = confirmCalendarChange } = {}) {
    this.dialog = dialog;
    this.approved = new Set();
  }

  async require(actionKey, action, details) {
    if (this.approved.has(actionKey)) return "session";

    const choice = await this.dialog({
      title: "Calendar change",
      action,
      details,
    });

    if (choice === "session") {
      this.approved.add(actionKey);
      return "session";
    }
    if (choice === "once") return "once";

    const error = new Error("The action was denied by the user.");
    error.code = "ACCESS_DENIED";
    throw error;
  }

  list() {
    return [...this.approved].sort();
  }
}
