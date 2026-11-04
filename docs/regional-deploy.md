# Prepare and deploy the regional topology

Dev and prod use their own desired `infra/envs/<env>.json` and identity lock. Both describe
US and Europe, an edge frontend, regional backends and automatic creation placement. Do not
edit `bound`, `CELLS`, migration history or generated configuration to bootstrap a deployment.

## Prepare resources, without deploying

From a clean committed checkout, inspect the same desired environment:

```sh
cargo xtask infra prepare --env prod --dry-run
```

This reads the live inventory and prints only missing D1, R2 and Queue creations. It writes
no file, creates no placeholder identity, deploys no Worker and moves no host. Use `dev` for
the identical development path. The command uses the environment's private deploy token,
`CLOUDFLARE_API_TOKEN`, or an explicit `--token-file`; the same in-memory credential is used
for its reads and creation subprocesses. Tokens never enter command arguments or output.

When resource creation is authorized:

```sh
cargo xtask infra prepare --env prod --confirm
```

Only declared missing resources are created, using their configured jurisdiction. Every
resource is read back. Only observed D1 identities replace `pending`; a previously recorded
identity that is absent or different stops preparation. Provider read/authentication errors
stop it too. Nothing deletes or replaces an existing database.

Preparation then writes the real identity lock and generated configurations and stops.
Review and commit those changes before deployment. A deploy still refuses pending or dirty
identities. Required and optional Worker secrets retain the existing private secrets-file
and per-region name mappings; preparation does not manufacture provider credentials.

## The normal guarded deploy

Run the usual local dev deployment, or the existing approved production ship pipeline.
Production confirmation, approved commit, dev evidence/ship checks and active-container gates
remain mandatory. Resource preparation is not a production release approval.

The deploy captures its revision, environment and Worker inventory before building. It checks
regional Worker settings before making changes. A documented Worker-not-found response is
eligible for bootstrap; permission failures, unknown errors, malformed responses and timeouts
stop the deployment. Already existing regions need no extra bootstrap.

When a desired bound region is missing, the ordinary plan automatically inserts:

1. Build the Wasm, frontend and runtime image once, and run normal D1 migrations.
2. Check active containers, then deploy the primary class provider from a temporary resolved
   configuration with service bindings to missing regions omitted.
3. Deploy each missing region from the same build, retaining its primary class bindings,
   durable identities, full migration history, real D1 identities and container image.
4. Apply secrets and verify the captured revision after each bootstrap deployment.
5. Recheck active containers, then perform the ordinary desired bound deployment in provider,
   regional backend and frontend order. Normal consumer, health and release checks still run.

Only missing regional service targets are omitted during bootstrap. Existing regional routes
remain. Automatic creation placement is held off in temporary bootstrap configurations until
the desired bound rollout restores it. The tracked desired spec and configurations are never
rewritten. Temporary configuration files are private, beside their original configuration so
relative build paths stay correct, and removed after each Wrangler invocation.

The final smoke verifies the captured deployment revision and inventory, even if a later
instruction-only commit advances the checkout's HEAD. Standalone `infra smoke` still verifies
current HEAD. A runtime, build-input or configuration edit during the deployment stops further
steps; a change during a remote step is reported as a failed deployment and requires a clean
restart. It never relabels mixed source as a newer release. Root instructions/docs-only changes
do not alter the captured application build.

## Retry and rollback

No failure triggers an automatic rollback. A failed bootstrap stops before the frontend
cutover. Re-running the normal guarded deploy discovers what now exists and resumes with the
same desired topology; preparation can likewise be repeated after a partial resource create.

Once regional repository IDs exist, retain their decoding, bindings, class identities and
registered-copy purge path. Do not roll back to a pre-region or pre-v9 binary. Disabling
automatic copies does not disable deletion/quarantine fencing. Follow the retained-binding
rollback in `regional-routing.md` and the release procedure in `ship-pipeline.md`.

## Evidence boundary

The local tests exercise pure bootstrap plans using actual desired dev/prod configuration,
readback/error classification, identity preservation, strict dry runs, captured-revision HTTP
smoke and source changes during deployment. They do not provision Cloudflare resources,
activate production, prove geographic placement, or replace the required dev and production
functional validation.
