---
title: Global network and data location
summary: YonedaRepo runs on our global network, with no region to pick. Here is where requests are served, where your data is stored, and what leaves our infrastructure.
---

## No region to pick

Requests are served from our global network: Git, the web app, the API and MCP all answer from it. You do not choose a region when you create an account or a repository, and there is nothing to configure.

## Where your data is stored

We host the service on managed infrastructure. Our main storage is placed in eastern North America, so **your data is processed in the United States**. This covers your account, your repositories and their history, change requests, sessions and transcripts, memories, LFS files and release assets.

Copies of content served to readers can be cached at other edge locations. This is why a [purge](/docs/guides/quarantine) cannot recall copies already cached elsewhere, and why a leaked credential should be rotated whatever else you do.

## Where work runs

| Work | Where |
|---|---|
| Requests (Git, web app, API, MCP) | our global network |
| Git over SSH | Through our SSH gateway; see [Git over HTTPS and SSH](/docs/guides/git-remotes#ssh) |
| Checks you define | Isolated containers, with no network; their code is sent nowhere else |
| Review agents | Isolated containers; their model calls go through our model gateway to the model's provider |

## What leaves our infrastructure

Some features send data to other providers, and those providers may process it in other countries:

- **Review agents** send the code and text they read to the provider of the model they run (for example OpenAI, Anthropic or Xiaomi), only on repositories whose owner turned them on; see [Review agents](/docs/agents/review-agents).
- **Model checks** send a commit's diff and message to Z.ai, only when a repository's landing rules define one.
- **Email** goes through Resend: your address and the message.
- **Sign-in with GitHub or Google** exchanges the sign-in with that provider, only if you use it.

The [Privacy Policy](/privacy) is the authoritative list of providers, what each one receives and how long data is kept.
