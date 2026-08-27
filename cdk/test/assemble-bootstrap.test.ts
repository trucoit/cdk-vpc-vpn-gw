import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assembleBootstrap } from '../lib/assemble-bootstrap';

describe('assembleBootstrap (synth-time #@include inlining)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-assemble-'));
    mkdirSync(join(dir, 'gw-files'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replaces an #@include anchor with the payload, keeping surrounding lines', () => {
    writeFileSync(join(dir, 'gw-files', 'body.sh'), 'line1\nline2\n');
    writeFileSync(
      join(dir, 'gw-bootstrap.sh'),
      ["cat > /dest <<'DELIM'", '#@include gw-files/body.sh', 'DELIM', 'chmod 0755 /dest', ''].join('\n'),
    );

    expect(assembleBootstrap(dir)).toBe(
      ["cat > /dest <<'DELIM'", 'line1', 'line2', 'DELIM', 'chmod 0755 /dest', ''].join('\n'),
    );
  });

  test('reconstructs a heredoc byte-for-byte (drops exactly one trailing newline)', () => {
    // The payload ends with a trailing newline; the surrounding join re-adds the
    // separator before the terminator, so the result equals the original inline form.
    const inline = ["cat <<'X'", 'a', 'b', 'X', ''].join('\n');
    writeFileSync(join(dir, 'gw-files', 'p'), 'a\nb\n');
    writeFileSync(join(dir, 'gw-bootstrap.sh'), ["cat <<'X'", '#@include gw-files/p', 'X', ''].join('\n'));
    expect(assembleBootstrap(dir)).toBe(inline);
  });

  test('leaves non-anchor lines (including ${...}) untouched', () => {
    writeFileSync(join(dir, 'gw-bootstrap.sh'), 'echo ${AWS::Region}\n# not an @include\n');
    expect(assembleBootstrap(dir)).toBe('echo ${AWS::Region}\n# not an @include\n');
  });

  test('throws if a referenced include file is missing', () => {
    writeFileSync(join(dir, 'gw-bootstrap.sh'), '#@include gw-files/missing.sh\n');
    expect(() => assembleBootstrap(dir)).toThrow();
  });
});

describe('assembleBootstrap on the real gateway script', () => {
  const scriptsDir = join(__dirname, '..', 'scripts');
  const assembled = assembleBootstrap(scriptsDir);

  test('expands every anchor (no #@include survives)', () => {
    expect(assembled).not.toMatch(/^#@include/m);
  });

  test('inlines the payload contents', () => {
    // Signatures from each extracted payload file.
    expect(assembled).toContain('iptables -P FORWARD DROP'); // gw-killswitch.sh
    expect(assembled).toContain('net.ipv4.ip_forward = 1'); // 99-custom-gw.conf
    expect(assembled).toContain('touch /run/gw-tunnel-up'); // tun-up.sh
    expect(assembled).toContain('set-instance-health'); // gw-healthcheck.sh
    expect(assembled).toContain('OnUnitActiveSec=1min'); // gw-healthcheck.timer
    expect(assembled).toContain('mssfix 1360'); // openvpn-overrides.conf
  });
});
