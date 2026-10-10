# OneCLI 1.42 Codex workspace compatibility

OneCLI already stores the real workspace ID in an OpenAI OAuth credential's
non-secret `metadata.accountId`. Its 1.42 Codex stub generator ignores that
field and emits `onecli-managed` in both workspace identity fields. Codex
0.156 and newer rejects that identity during workspace routing discovery.

This local image patch passes the selected credential's existing account ID
to both stub endpoints. It updates `tokens.account_id` and the dummy ID token's
`chatgpt_account_id` claim. Access and refresh tokens remain placeholders;
no real credential is decrypted or copied into a container. Missing account
metadata retains the original stub behavior. Agent grants and API-key mode
are unchanged.

Build from the repository root:

```bash
docker build --pull=false -f ops/onecli-codex-workspace/Dockerfile \
  -t onecli-local:1.42.0-codex-workspace .
```

The base image and compiled bundle checksum are pinned. An unexpected bundle
fails the patch rather than guessing at compiled symbol names. The build runs
the regression check against the actual patched factory.

This installation's `/home/masuel/.onecli/docker-compose.override.yml` selects
the derivative image. The gateway still reports 1.42.0. Remove this override
when adopting an upstream gateway release that fixes workspace metadata;
review the NanoClaw OneCLI version constraint before upgrading.

To undo this patch, stop NanoClaw, remove only the local image override, and
recreate the original image with the retained Compose rollback file:

```bash
docker compose -f /home/masuel/.onecli/docker-compose.yml \
  -f /home/masuel/nanoclaw-v2/data/onecli-workspace-recovery-20261010/docker-compose.original-image.yml \
  up -d --no-deps --pull never onecli
```

That rollback file preserves the original Docker bridge bindings and gateway
URLs; removing the override alone would revert to Compose's loopback defaults.
Restore the previous Codex skill/manifest pin and agent model settings if
returning to the original gateway. The original agent image is retained as
`nanoclaw-agent-v2-60674f0e:pre-codex-01621`. Restart NanoClaw and verify a
real reply. Database restoration is unnecessary for this code-only patch.
