/** Process-local package policy; never persist it in host apt/needrestart config.
 * Suspend the apt hook (which may explicitly request automatic restarts), with
 * list-only as a fallback for direct needrestart calls. Package maintainer
 * scripts still own their package lifecycle; unrelated needrestart restarts and
 * reboot decisions must wait for separately authorized maintenance.
 */
export function noninteractiveHostPackageCommand(command: string): string {
  return `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1\n${command}`;
}
