export async function resolveBinary() {
  return process.env.OCPP_PTY_BIN || "opencode-pty"
}
