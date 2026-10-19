// Error text for logs. Backend errors may quote the command line or stderr,
// which can contain the UDID; the global log identifier already carries the
// serial, so it is masked here.
export function errorMessage(err: unknown, serial?: string) {
  const text = err instanceof Error ? err.message : String(err)
  return serial ? text.split(serial).join('<udid>') : text
}
