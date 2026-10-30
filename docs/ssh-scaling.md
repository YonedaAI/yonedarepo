# Scaling Git over SSH

Status: plan, not built. Written 2026-10-30.

## Today

Git over SSH runs through one `SshGateway` container:

```
git → cloudflared (user's machine) → Cloudflare Tunnel → SshGateway container → platform Worker
```

- One named instance (`gateway()` in `cloudflare/worker/platform-ssh-gateway.ts`), kept running by the platform's cron (`sshKeepAlive`).
- Instance type `basic`, `max_instances: 2`, region constraint `ENAM`, in `infra/envs/{dev,prod}.json`.
- About $7 a month for one always-on `basic` instance (recorded in the spec's notes).
- It verifies the key and bridges to smart HTTP. Git work itself runs in Workers and Durable Objects, which scale on their own. HTTPS Git and `yoneda` clones never touch the gateway.

The gateway's capacity has not been measured.

## What Cloudflare gives us

- **Containers do not autoscale.** Each instance is started by its own ID and runs until `sleepAfter` or a stop. `getRandom` picks among a fixed number of instances, regardless of location.
- **Tunnel replicas give availability, not load balancing.** Several `cloudflared` instances can serve one tunnel, each opening four connections, but Cloudflare sends each request to the nearest replica and retries others if that fails. Replicas do not support traffic steering. Evenly spreading traffic needs Cloudflare Load Balancers.

Sources: [Containers scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/), [Tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/).

## Step 1: two gateways, for availability

Goal: a crash or a deploy of one gateway does not take SSH down. This does not double capacity, because all gateways share a region, so one replica may take most of the traffic.

1. `gateway()` takes an index; names are stable (`ssh-gateway-0`, `ssh-gateway-1`).
2. `sshKeepAlive` wakes each one, with each failure logged on its own.
3. Each container runs `cloudflared` with the same `SSH_TUNNEL_TOKEN`.
4. Keep `max_instances` at 2 or more. Cost is about $14 a month.
5. The `connect` front door, if it is ever used, picks an instance by hash of the connection, or stays on one instance.

Verify on dev before prod:

- Stop one gateway during a clone: new clones keep working; the open session ends and Git reports it. Kit item 26 passes after.
- Roll a deploy during repeated clones: at least one gateway answers throughout. If a rollout replaces both at once, change `rollout_step_percentage` so it does not.
- `/internal/ssh/status` shows both tunnels connected.

## Step 2: measure before adding more

Write the request budget first (open sessions, clone throughput, memory per session), then benchmark one gateway from a machine near `ENAM`: at least 3 runs, min/median/max, with real-history repositories. Add gateways or a bigger instance type only for a measured limit.

## Step 3: more capacity

Pick from what step 2 shows:

| Limit found | Change |
|---|---|
| Memory or CPU per gateway | Larger `instance_type` |
| Users far from `ENAM` | Gateways in more regions; nearest-replica routing then helps |
| Many sessions in one region | Cloudflare Load Balancers across replicas (a paid add-on; price to be checked) |
| Demand changes through the day | A small Worker reads open sessions and starts or stops named instances |

A session-count autoscaler is the last resort: gateways are cheap and always-on pool sizes are simpler. Libraries evaluated so far: [container-autoscaling.md](container-autoscaling.md).

## Separate from this plan

Removing the tunnel from the user's machine needs a public TCP port, which on Cloudflare means Spectrum. Spectrum needs an origin it can reach; `SSH_FRONT_DOOR=connect` (Spectrum to the Worker) is a private beta and has not run live.
