import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Assemble the gateway boot script from its orchestrator + payload files.
 *
 * `gw-bootstrap.sh` is the orchestrator. Its helper scripts and systemd unit
 * files live as real, editable files under `scripts/gw-files/` (so they get
 * syntax highlighting, and can be linted / read on their own). Each one is
 * referenced from the orchestrator by a single anchor line that is the sole body
 * of a quoted heredoc, e.g.
 *
 *     cat > /usr/local/sbin/gw-killswitch.sh <<'KILLSWITCH'
 *     #@include gw-files/gw-killswitch.sh
 *     KILLSWITCH
 *     chmod 0755 /usr/local/sbin/gw-killswitch.sh
 *
 * This function replaces every `#@include <path>` line with the verbatim
 * contents of `<path>` (resolved relative to `scriptsDir`). It is a pure line
 * substitution: no bash is generated here, and all the shell scaffolding
 * (`cat`, the heredoc delimiter, `chmod`, create-vs-append, ordering) stays in
 * the orchestrator. The output is a single string, byte-for-byte equivalent to
 * the pre-refactor single-file script, which the caller then wraps in
 * `Fn.base64(Fn.sub(...))` exactly as before — so `${...}` placeholders that
 * remain in the payloads still resolve as CloudFormation substitutions.
 *
 * @param scriptsDir absolute path to the `scripts/` directory holding
 *   `gw-bootstrap.sh` and the `gw-files/` payloads.
 */
export function assembleBootstrap(scriptsDir: string): string {
  const orchestrator = readFileSync(join(scriptsDir, 'gw-bootstrap.sh'), 'utf8');
  const includeRe = /^#@include[ \t]+(\S+)[ \t]*$/;

  return orchestrator
    .split('\n')
    .map((line) => {
      const match = includeRe.exec(line);
      if (!match) return line;
      // Drop exactly one trailing newline: the payload file ends with "\n", and
      // the surrounding join('\n') re-adds the separator before the heredoc
      // terminator, so the reconstruction matches the original byte-for-byte.
      return readFileSync(join(scriptsDir, match[1]), 'utf8').replace(/\n$/, '');
    })
    .join('\n');
}
