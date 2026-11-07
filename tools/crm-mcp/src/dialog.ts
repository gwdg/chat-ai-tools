import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ConfirmationChoice = "session" | "once" | "deny";

export interface ConfirmationRequest {
  title?: string;
  action: string;
  details: string;
}

export type ConfirmationDialog = (
  request: ConfirmationRequest,
) => Promise<ConfirmationChoice>;

const TIMEOUT_MS = (() => {
  const value = Number(process.env.CRM_MCP_DIALOG_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 300_000;
  return Math.min(Math.max(Math.trunc(value), 10_000), 900_000);
})();

const EXEC_OPTIONS = {
  timeout: TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: 1024 * 1024,
};

function messageFor({ action, details }: ConfirmationRequest): string {
  return [
    `The AI assistant wants to ${action}.`,
    "",
    details,
    "",
    "Allow once confirms only this action.",
    "Allow for session remembers this approval until the MCP server stops.",
    "Deny blocks it.",
  ].join("\n");
}

function timeoutError(): Error {
  return new Error(
    `The confirmation dialog did not receive an answer within ${TIMEOUT_MS} ms.`,
  );
}

const MAC_SCRIPT = `
on run argv
  set dialogTitle to item 1 of argv
  set dialogMessage to item 2 of argv
  try
    set result to display dialog dialogMessage with title dialogTitle buttons {"Deny", "Allow once", "Allow for session"} default button "Deny" cancel button "Deny"
    return button returned of result
  on error number -128
    return "Deny"
  end try
end run
`;

async function macDialog(title: string, message: string): Promise<ConfirmationChoice> {
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", MAC_SCRIPT, "--", title, message],
      EXEC_OPTIONS,
    );
    const value = stdout.trim();
    if (value === "Allow for session") return "session";
    if (value === "Allow once") return "once";
    return "deny";
  } catch (error) {
    if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) {
      throw timeoutError();
    }
    throw new Error(
      `Could not open the macOS confirmation dialog: ${(error as Error).message}`,
    );
  }
}

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:CRM_MCP_DIALOG_TITLE
$form.ClientSize = New-Object System.Drawing.Size(760, 520)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$font = New-Object System.Drawing.Font("Segoe UI", 10)
$text = New-Object System.Windows.Forms.TextBox
$text.Multiline = $true
$text.ReadOnly = $true
$text.ScrollBars = "Vertical"
$text.Font = $font
$text.Left = 16
$text.Top = 16
$text.Width = 728
$text.Height = 340
$text.Text = $env:CRM_MCP_DIALOG_MESSAGE
$form.Controls.Add($text)
$session = New-Object System.Windows.Forms.Button
$session.Text = "Allow for session"
$session.Font = $font
$session.Left = 16
$session.Top = 380
$session.Width = 190
$session.Height = 38
$once = New-Object System.Windows.Forms.Button
$once.Text = "Allow once"
$once.Font = $font
$once.Left = 220
$once.Top = 380
$once.Width = 150
$once.Height = 38
$deny = New-Object System.Windows.Forms.Button
$deny.Text = "Deny"
$deny.Font = $font
$deny.Left = 384
$deny.Top = 380
$deny.Width = 110
$deny.Height = 38
$script:choice = "deny"
$session.Add_Click({ $script:choice = "session"; $form.Close() })
$once.Add_Click({ $script:choice = "once"; $form.Close() })
$deny.Add_Click({ $script:choice = "deny"; $form.Close() })
$form.Controls.AddRange(@($session, $once, $deny))
$form.AcceptButton = $deny
$form.CancelButton = $deny
[void]$form.ShowDialog()
Write-Output $script:choice
`;

async function windowsDialog(title: string, message: string): Promise<ConfirmationChoice> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      {
        ...EXEC_OPTIONS,
        env: {
          ...process.env,
          CRM_MCP_DIALOG_TITLE: title,
          CRM_MCP_DIALOG_MESSAGE: message,
        },
      },
    );
    const value = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (value === "session") return "session";
    if (value === "once") return "once";
    return "deny";
  } catch (error) {
    if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) {
      throw timeoutError();
    }
    throw new Error(
      `Could not open the Windows confirmation dialog: ${(error as Error).message}`,
    );
  }
}

async function kdialogYesNo(title: string, message: string): Promise<boolean> {
  try {
    await execFileAsync(
      "kdialog",
      ["--title", title, "--geometry", "760x400", "--defaultno", "--yesno", message],
      EXEC_OPTIONS,
    );
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) {
      throw timeoutError();
    }
    throw error;
  }
}

async function linuxDialog(title: string, message: string): Promise<ConfirmationChoice> {
  try {
    const { stdout } = await execFileAsync(
      "zenity",
      [
        "--list",
        "--radiolist",
        "--title",
        title,
        "--text",
        message,
        "--column",
        "",
        "--column",
        "Action",
        "TRUE",
        "Deny",
        "FALSE",
        "Allow once",
        "FALSE",
        "Allow for session",
        "--print-column=2",
        "--width=760",
        "--height=560",
      ],
      EXEC_OPTIONS,
    );
    const value = stdout.trim();
    if (value.includes("Allow for session")) return "session";
    if (value.includes("Allow once")) return "once";
    return "deny";
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "deny";
    if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) {
      throw timeoutError();
    }
  }

  try {
    const allow = await kdialogYesNo(
      title,
      `${message}\n\nAllow this action?`,
    );
    if (!allow) return "deny";

    const remember = await kdialogYesNo(
      title,
      `${message}\n\nRemember this action for the rest of the session?`,
    );
    return remember ? "session" : "once";
  } catch (error) {
    if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) {
      throw timeoutError();
    }
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(
        "No confirmation dialog is available. Install zenity or kdialog.",
      );
    }
    throw new Error(
      `Could not open the Linux confirmation dialog: ${(error as Error).message}`,
    );
  }
}

export const confirmAction: ConfirmationDialog = async (request) => {
  const title = request.title ?? "CRM action confirmation";
  const message = messageFor(request);

  if (process.platform === "darwin") return macDialog(title, message);
  if (process.platform === "win32") return windowsDialog(title, message);
  return linuxDialog(title, message);
};
