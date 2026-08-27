# Uploading the VPN profile

In `PublicPrivateCustomRouting` mode the stack creates a private, encrypted S3 bucket
for the OpenVPN client files. The gateway pulls those files at boot, brings up the
tunnel, and only then opens private egress. Until a valid profile is in the bucket the
gateway comes up fail-closed and drops all forwarded traffic, by design.

This doc applies when the gateway runs in VPN mode, which is the default. With
`EnableVpn=false` the gateway is a plain NAT instance with no tunnel, so none of the
steps here apply and no profile is needed.

This doc covers what to upload, the exact format the boot script expects, and how to
apply a change. For checking the tunnel afterward, see the [operations runbook](operations.md).

## Contents

- [Get the bucket name](#get-the-bucket-name)
- [Upload the profile](#upload-the-profile)
- [Username and password profiles](#username-and-password-profiles)
- [Apply the change](#apply-the-change)
- [Profile format requirements](#profile-format-requirements)
- [Warnings](#warnings)

## Get the bucket name

The bucket name is the `CustomGatewayVpnBucket` stack output:

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name my-vpc \
  --query "Stacks[0].Outputs[?OutputKey=='CustomGatewayVpnBucket'].OutputValue" \
  --output text)
echo "$BUCKET"
```

## Upload the profile

Copy one OpenVPN client profile to the bucket root. The file must end in `.ovpn` or
`.conf`, and its certs and keys should be embedded inline (see
[format requirements](#profile-format-requirements)).

```bash
aws s3 cp client.ovpn "s3://$BUCKET/"
aws s3 ls "s3://$BUCKET/"          # confirm what is in the bucket
```

The gateway does not need the routing or interface directives. At boot it strips any
`dev`, `dev-type`, `redirect-gateway`, `route`, and `route-nopull` lines from your
profile and appends its own (`dev tun0`, `nobind`, `persist-tun`, the up/down scripts,
and an mssfix clamp). Leave those to the gateway.

## Username and password profiles

Commercial providers such as NordVPN authenticate with a username and password rather
than a client certificate. Their profile carries a bare `auth-user-pass` line. Upload
a second file named exactly `credentials.txt` with the username on line 1 and the
password on line 2:

```bash
printf '%s\n%s\n' 'SERVICE_USERNAME' 'SERVICE_PASSWORD' > credentials.txt
aws s3 cp credentials.txt "s3://$BUCKET/"
```

At boot the gateway locks that file to `0600` and rewrites the profile's bare
`auth-user-pass` to point at it, so the tunnel starts without an interactive prompt.

> [!IMPORTANT]
> With NordVPN, use the **service credentials** from the Nord dashboard (Nord Account,
> Services, NordVPN, "Set up NordVPN manually"), not your account login. Your account
> email and password will not authenticate the tunnel.

## Apply the change

Uploading a file does nothing on its own. The gateway reads the bucket only at boot, so
refresh the instance to pull the new files. Either terminate it and let the Auto Scaling
group relaunch it, or start an instance refresh:

```bash
# Option A: terminate; the size-1 ASG launches a replacement
aws autoscaling terminate-instance-in-auto-scaling-group \
  --instance-id <instance-id> --no-should-decrement-desired-capacity

# Option B: instance refresh on the gateway ASG
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name <StackName>-custom-gw
```

> [!WARNING]
> Refreshing the gateway drops private egress for the length of the replacement boot,
> roughly one to three minutes. Do it in a maintenance window if the private tier is
> serving traffic.

Then verify with the [egress and tunnel checks](operations.md#egress-verification).

## Profile format requirements

The profile must be a standard OpenVPN **client** config that the gateway can start
non-interactively. Concretely:

- **One profile only.** The boot script picks the first `.ovpn` or `.conf` file in
  alphabetical order. Keep exactly one in the bucket.
- **Embed certs and keys inline** in `<ca>`, `<cert>`, `<key>`, and `<tls-crypt>` (or
  `<tls-auth>`) blocks. Separate cert files referenced by path will not resolve, because
  the assembled config runs from `/etc/openvpn/client/`, not from `/etc/vpn/`.
- **Keep `remote`, `proto`, `cipher`, and auth directives.** These are yours to set.
- **Omit `dev`, `redirect-gateway`, and `route` lines.** They are stripped and replaced.
- **For password auth, use a bare `auth-user-pass`** (no path argument). Only the bare
  form is rewritten to point at `credentials.txt`. An inline path or an already-embedded
  credential will not be touched, and a bare line with no `credentials.txt` uploaded will
  hang the tunnel on a prompt.

## Warnings

> [!CAUTION]
> The `.ovpn` profile and `credentials.txt` are secrets. Keep them only in this bucket.
> Never commit them to the repo or paste them into logs or tickets. The bucket is
> private, SSE-encrypted, blocks all public access, and rejects non-TLS requests, and
> the gateway locks `credentials.txt` to `0600` on the instance.

> [!WARNING]
> A wrong or unreachable profile keeps the gateway fail-closed. The tunnel never
> verifies, the health watchdog marks the instance unhealthy after five failed checks,
> and the Auto Scaling group replaces it, which can loop while the profile stays broken.
> Fix the profile in the bucket, then refresh once.

> [!NOTE]
> S3 refuses to delete a bucket that still holds objects. Empty this bucket (remove the
> profile and `credentials.txt`) before tearing the stack down. There is no auto-delete.
