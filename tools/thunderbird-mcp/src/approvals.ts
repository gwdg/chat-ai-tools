import type { ConfirmationDialog } from "./dialog.js";
import { confirmAction } from "./dialog.js";
import { UserError } from "./profile.js";

export class ActionApprovals {
  private readonly approved = new Set<string>();

  constructor(private readonly dialog: ConfirmationDialog = confirmAction) {}

  async require(
    actionKey: string,
    action: string,
    details: string,
    title?: string,
  ): Promise<void> {
    if (this.approved.has(actionKey)) return;

    const choice = await this.dialog({ title, action, details });
    if (choice === "session") {
      this.approved.add(actionKey);
      return;
    }
    if (choice === "once") return;

    throw new UserError("The action was denied by the user.");
  }

  list(): string[] {
    return [...this.approved].sort();
  }
}
