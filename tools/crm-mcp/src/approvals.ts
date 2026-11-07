import type { ConfirmationChoice, ConfirmationDialog } from "./dialog.js";
import { confirmAction } from "./dialog.js";
import { UserError } from "./errors.js";

export class ActionApprovals {
  private readonly approved = new Set<string>();

  constructor(private readonly dialog: ConfirmationDialog = confirmAction) {}

  async require(
    actionKey: string,
    action: string,
    details: string,
  ): Promise<ConfirmationChoice> {
    if (this.approved.has(actionKey)) return "session";

    const choice = await this.dialog({ action, details });
    if (choice === "session") {
      this.approved.add(actionKey);
      return "session";
    }
    if (choice === "once") return "once";

    throw new UserError("The action was denied by the user.");
  }

  list(): string[] {
    return [...this.approved].sort();
  }
}
