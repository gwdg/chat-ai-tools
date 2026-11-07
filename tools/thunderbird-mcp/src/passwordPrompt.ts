import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 300_000;
const EXEC_OPTIONS = {
  timeout: TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: 1024 * 1024,
};

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "Thunderbird MCP HTTP password"
$form.ClientSize = New-Object System.Drawing.Size(560, 200)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$font = New-Object System.Drawing.Font("Segoe UI", 10)
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:THUNDERBIRD_MCP_PASSWORD_PROMPT
$label.Font = $font
$label.Left = 16
$label.Top = 16
$label.Width = 520
$label.Height = 60
$text = New-Object System.Windows.Forms.TextBox
$text.Font = $font
$text.UseSystemPasswordChar = $true
$text.Left = 16
$text.Top = 90
$text.Width = 520
$ok = New-Object System.Windows.Forms.Button
$ok.Text = "OK"
$ok.Font = $font
$ok.Left = 330
$ok.Top = 140
$ok.Width = 95
$ok.Height = 34
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel"
$cancel.Font = $font
$cancel.Left = 435
$cancel.Top = 140
$cancel.Width = 95
$cancel.Height = 34
$script:password = ""
$ok.Add_Click({ $script:password = $text.Text; $form.Close() })
$cancel.Add_Click({ $script:password = ""; $form.Close() })
$form.Controls.AddRange(@($label, $text, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
[void]$form.ShowDialog()
Write-Output $script:password
`;

const MAC_SCRIPT = `
on run argv
  set promptText to item 1 of argv
  try
    set result to display dialog promptText with title "Thunderbird MCP password" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
    return text returned of result
  on error number -128
    return ""
  end try
end run
`;

async function windowsPassword(message: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      {
        ...EXEC_OPTIONS,
        env: {
          ...process.env,
          THUNDERBIRD_MCP_PASSWORD_PROMPT: message,
        },
      },
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  } catch (error) {
    throw new Error(
      `Could not open the Windows password prompt: ${(error as Error).message}`,
    );
  }
}

async function macPassword(message: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", MAC_SCRIPT, "--", message],
      EXEC_OPTIONS,
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Could not open the macOS password prompt: ${(error as Error).message}`,
    );
  }
}

async function linuxPassword(message: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "zenity",
      [
        "--entry",
        "--hide-text",
        "--title",
        "Thunderbird MCP HTTP password",
        "--text",
        message,
        "--width=520",
      ],
      EXEC_OPTIONS,
    );
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    if ((error as { code?: string }).code !== "ENOENT") {
      // Fall through to kdialog.
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "kdialog",
      ["--password", message, "--title", "Thunderbird MCP HTTP password"],
      EXEC_OPTIONS,
    );
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(
        "No password dialog is available. Install zenity or kdialog, or set the password with --password or THUNDERBIRD_MCP_PASSWORD.",
      );
    }
    throw new Error(
      `Could not open the Linux password prompt: ${(error as Error).message}`,
    );
  }
}

export async function promptPassword(message: string): Promise<string> {
  if (process.platform === "darwin") return macPassword(message);
  if (process.platform === "win32") return windowsPassword(message);
  return linuxPassword(message);
}
