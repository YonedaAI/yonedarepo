# Autoscaling Cloudflare Containers

Status: evaluated 2026-10-30. Nothing adopted.

**Decision: do not use `@abhi-arya1/autoscaled`.** Stay on the official `@cloudflare/containers` and follow [ssh-scaling.md](ssh-scaling.md). Its design is a useful reference.

This comes from reading the package source (version 0.1.0). The package was not run.

## The package

| Check | Result |
|---|---|
| Maturity | 0.1.0; 2 releases, both 2025-12-17; last push the same day; 1 star; 15 downloads in the month to 2026-10-29; one maintainer; ISC licence |
| Tests | None in the published package |
| SDK version | Depends on `@cloudflare/containers` ^0.0.31; we pin 0.3.7. Compatibility is unproven |
| Official SDK | `getRandom` is described as temporary, and `autoscaling: true` as "not yet implemented", so Cloudflare intends to cover this |

## Why it does not fit our containers

| Our container | How it gets work | Fit |
|---|---|---|
| `SshGateway` | cloudflared inside the container takes SSH directly from Tunnel | None. The traffic never passes through the Worker, so the library's `fetch` routing and request counts see nothing. It has no TCP (`connect`) path |
| `PackBuilder` | One per repository, by name | None. The library picks any instance, under random `nanoid` names |
| `CheckContainer`, managed harness | One per run or job | None, for the same reason |

## Faults that matter for Git

1. **Long transfers look finished.** The request count drops when `container.fetch()` returns headers, not when the body ends (`src/index.ts:319`). A clone streaming for minutes counts as 0 active, so scale-down can pick that instance.
2. **Scale-down destroys.** `drainTimeout` defaults to 60 s, then `destroyInstance` runs, ending open work (`src/index.ts:517-525`).
3. **One Durable Object in the path.** Every request goes through one `Autoscaler` object: a single point of failure and a throughput cap, which our design avoids.
4. **Fills instances in list order**, not least-loaded (`src/router.ts`).
5. **Requires a monitor** on port 81 in each image, plus health on port 8080 unless configured.
6. Config names carry a typo (`scaleThesholdCPU`), a sign of an unreviewed public API.

## Ideas worth keeping

- Minimum instances, so one is always warm.
- Separate cooldowns for scaling up and down.
- Draining an instance before stopping it.
- An evaluation loop driven by Durable Object alarms.
- Scaling up before capacity is reached (it uses 70%).

## Signals

Active Git operations and container concurrency are the right signals for us, not CPU. Queue depth does not apply to SSH sessions. Any scaler must count a session until it ends, not until its headers return.

## When to look again

- Cloudflare ships `autoscale: true` in the SDK. Check this first.
- [ssh-scaling.md](ssh-scaling.md) step 2 measures a limit that a fixed pool of gateways cannot meet.

Cloud Foundry App Autoscaler is useful only as a design reference. Kubernetes HPA and KEDA do not apply.

## Sources

- [`@abhi-arya1/autoscaled` on npm](https://www.npmjs.com/package/@abhi-arya1/autoscaled)
- [abhi-arya1/autoscaled](https://github.com/abhi-arya1/autoscaled)
- [cloudflare/containers](https://github.com/cloudflare/containers)
- [Containers scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/)
