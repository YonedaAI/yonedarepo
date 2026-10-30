---
title: Credit and usage
summary: What a review run costs, the starting credit, and what happens when the credit runs out.
---

## Starting credit

Each workspace (your account, or an organization) gets **$5 of credit** when it first turns on a review agent for a repository. The **Agents** page shows it on the card **This one is on us!**, with how much is used.

## What a run costs

A run is charged for two things:

| Part | Price |
|---|---|
| Model use | The model's tokens at the provider's list price, plus 30% |
| Container time | $0.0017 a minute, billed by the second |

Before each model call the run holds its worst-case cost, then settles on the usage the model reports. Model spend per run is capped: $1 for Code review, $3 for Security review and $0.50 for Slop review; a run stops there. Current model prices are on the [pricing page](/pricing).

## Where to see usage

- **Agents** page: the credit used and left.
- **Settings → Billing** (for your personal account): **Credit balance**, and **Usage by repository and agent**.
- Each run's page: a cost table for that run.

## When the credit runs out

Runs stop and show **Paused (no credit)**; nothing more is charged. Adding credit yourself is not available yet: **Set up billing** is marked **Coming soon**.
