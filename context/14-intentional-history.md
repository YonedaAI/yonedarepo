# 14. Intentional history, assumptions, and the incident demo

[Index](index.md) · [Previous](13-engineering-and-business-framing.md) · [Next](15-context-graph-paper.md)

*Substantive turn 14 of 18, in original conversation order.*

## User

Our system solves for this 

Lack of Intentional History and Context
• No "Why" Behind Decisions: When a human writes code, they possess a mental model of why they chose a specific abstraction or logic gate. AI coding agents do not inherently retain a historical memory of their reasoning.
• The "Black Box" Shift: The paradigm is shifting from "we understand why the system works" to "we've verified that it passes tests." When a complex production issue arises months later—such as a memory leak or a database timeout under heavy load—engineers struggle to fix it because no human on the team originally formulated the architectural logic.

## ChatGPT

Yes. **That is much closer to the fundamental problem you're solving.** The parallel-agent/solution-space system is how the product operates, but the durable business value is preventing software from becoming **code without institutional understanding**.

I'd frame the problem this way:

> **AI is increasing the rate at which organizations create code while decreasing the amount of human understanding attached to that code.**

Git preserves **what changed**. Tests establish **whether something appears to work**. Neither preserves enough of **why the system became what it is**.

#### The emerging problem

With human-written software, a surprising amount of architecture exists as undocumented human memory:

```
Engineer
   │
   ├── requirements
   ├── conversations
   ├── rejected ideas
   ├── production knowledge
   ├── architectural assumptions
   └── reasoning
           │
           ▼
          Code
```

Even when documentation is poor, someone frequently remembers:

> "We tried connection pooling there, but it caused X."

> "That weird abstraction exists because customer Y required Z."

> "Don't make this asynchronous because ordering matters."

Agentic development breaks that implicit mechanism.

```
Prompt
   ↓
Agent
   ↓
Code
   ↓
Tests pass
   ↓
Ship
```

Three months later:

```
Production incident
        ↓
Why is this designed this way?
        ↓
       ???
```

The transcript may be gone, inaccessible, enormous, or disconnected from the exact code that survived.

That is the **Black Box Software problem**.

---

### What we add

Your system changes the development record from:

```
Commit
 ├── author
 ├── timestamp
 ├── message
 └── diff
```

to something closer to:

```
Decision
│
├── Intent
│
│   └── What were we trying to accomplish?
│
├── Context
│   ├── What code did the agent inspect?
│   ├── What requirements did it receive?
│   ├── What prior decisions did it consume?
│   └── What constraints were known?
│
├── Exploration
│   ├── Candidate A
│   ├── Candidate B
│   └── Candidate C
│
├── Reasoning artifacts
│   ├── assumptions
│   ├── architectural rationale
│   ├── tradeoffs
│   └── identified risks
│
├── Evidence
│   ├── tests
│   ├── benchmarks
│   ├── security checks
│   └── evaluations
│
├── Rejections
│   └── Why weren't the alternatives selected?
│
└── Decision
    ├── selected candidate
    ├── why it won
    └── resulting revision
```

That's **intentional history**.

And importantly, I would avoid claiming we're storing an LLM's private/internal chain of thought. We don't need it.

We preserve **explicit decision artifacts**: intent, constraints, assumptions, alternatives, rationale, evidence, and outcomes.

That's actually better engineering data.

---

### Context Graph becomes central

Now I think the Context Graph has a very clear purpose:

> **The Context Graph is a persistent causal graph connecting production code to the intent, context, decisions, alternatives, and evidence that created it.**

Consider:

```
                    Requirement
                        │
                        ▼
                  INTENT I-104
                        │
            "Reduce DB latency"
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
      Context        Context        Context
      schema         metrics        prior ADR
          │             │             │
          └─────────────┼─────────────┘
                        ▼
                  Agent execution
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
        Candidate A Candidate B Candidate C
        pool=100    pool=20     multiplex
             │          │          │
             ▼          ▼          ▼
            FAIL       PASS       PASS
          memory       best       complex
             │          │          │
             └──────────┼──────────┘
                        ▼
                  DECISION D-82
                        │
              "Choose pool=20"
                        │
                        ▼
                  Revision 91ab
                        │
                        ▼
             db/connection_pool.rs
```

Six months later, that file has a production problem.

An engineer clicks the code and gets the history that matters.

---

### The killer incident demo

This might actually be a **better competition demo** than merely showing three agents coding simultaneously.

Start with the parallel-agent demo.

Three agents implement database connection management.

The winning solution ships.

Then jump forward:

> **"Six months later..."**

Simulate:

```
ALERT

Database connection exhaustion
p99 latency: 4.8s
```

Engineer opens:

```
src/db/pool.rs
```

Traditional workflow:

```
git blame
    ↓
commit a82c71
    ↓
"Improve database pooling"
```

Not very useful.

Your system:

```
pool.rs
  │
  ▼
Revision 91ab
  │
  ▼
Decision D82
  │
  ├── Intent
  │      reduce DB latency
  │
  ├── Assumption
  │      expected concurrency <500
  │
  ├── Constraint
  │      database max_connections=250
  │
  ├── Candidate A
  │      pool=100
  │      REJECTED: memory pressure
  │
  ├── Candidate B ★
  │      pool=20
  │      SELECTED
  │
  ├── Candidate C
  │      multiplexing
  │      REJECTED: complexity
  │
  └── Benchmark
         tested at 400 concurrent users
```

And suddenly the incident becomes obvious:

```
Production concurrency today:
2,800

Original design assumption:
<500
```

**That's the moment the product clicks.**

The system doesn't merely tell the engineer what the AI wrote.

It tells them:

> **The assumption under which this code was considered correct is no longer true.**

That's extraordinarily useful.

---

### That's beyond provenance

Provenance says:

> Agent X generated this.

Your system should say:

> Agent X generated this **because of Y, under assumptions A/B/C, after considering alternatives D/E, validated by evidence F, resulting in decision G.**

That's closer to **causal provenance**.

I'd therefore separate:

##### Provenance

```
Who/what produced this?
```

##### Context

```
What information influenced it?
```

##### Intent

```
What outcome was sought?
```

##### Rationale

```
Why was this approach preferred?
```

##### Evidence

```
Why did we believe it worked?
```

##### Assumptions

```
Under what conditions was that conclusion valid?
```

##### Alternatives

```
What else was considered?
```

Together they form intentional history.

---

### Assumptions should become first-class objects

This conversation actually makes me want to modify our schema.

Add:

```
pub struct Assumption {
    pub id: AssumptionId,

    pub statement: String,

    pub scope: Scope,

    pub source: Source,

    pub confidence: Confidence,

    pub status: AssumptionStatus,
}
```

For example:

```
A-128

"Peak concurrent database requests will remain below 500."

Applies to:
    Candidate C84
    db/pool.rs

Evidence:
    load-test-92

Status:
    VALID
```

Now imagine production telemetry eventually shows:

```
concurrency > 500
```

The graph can mark:

```
A-128

ASSUMPTION POTENTIALLY INVALID
```

And trace:

```
Assumption A128
      │
      ▼
Decision D82
      │
      ▼
Revision
      │
      ├── pool.rs
      ├── connection.rs
      └── config.rs
```

Now you've gone beyond documentation into **maintainable machine-generated architecture**.

---

### It also changes AI maintenance

Future coding agents shouldn't receive only:

```
repository files
```

They should receive:

```
repository files
+
relevant Context Graph
```

So:

```
              FUTURE AGENT
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       Source             Context Graph
          │                   │
          │              intent
          │              decisions
          │              assumptions
          │              alternatives
          │              incidents
          │              evidence
          └─────────┬─────────┘
                    ▼
              better change
```

That solves another major problem:

> **AI agents currently inherit code but not the organizational understanding that produced the code.**

Your Context Graph makes that understanding machine-readable and reusable.

---

### Business positioning

I wouldn't lead with:

> "Multi-agent Git platform."

I'd lead with:

> **AI can write your code. Who remembers why it wrote it?**

Then:

> AgentRepo creates an intentional history of AI-generated software—connecting every important code decision to its original intent, context, assumptions, alternatives, and verification evidence.

And then the consequence:

> When production fails months later, engineers and future agents don't start from the code alone. They inherit the reasoning context that created it.

That's a significantly stronger story.

---

### Engineering positioning

Technically:

> **AgentRepo is a persistent context and decision graph for autonomous software engineering, coupled to a multi-agent execution and verification control plane.**

Architecture:

```
                       AGENTREPO

             ┌─────────────────────────┐
             │      CONTEXT GRAPH      │
             │                         │
             │ Intent                  │
             │ Context                 │
             │ Assumptions             │
             │ Decisions               │
             │ Alternatives            │
             │ Evidence                │
             │ Incidents               │
             └────────────┬────────────┘
                          │
                 causal relationships
                          │
             ┌────────────▼────────────┐
             │    AGENT CONTROL PLANE  │
             │                         │
             │ Plan                    │
             │ Execute                 │
             │ Compare                 │
             │ Evaluate                │
             │ Reconcile               │
             │ Decide                  │
             └────────────┬────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        Claude/Codex             Future agents
              │
              ▼
       Cloudflare Containers
              │
              ▼
       Cloudflare Artifacts
              │
              ▼
             CODE
```

And I'd make the product principle:

> **Code should never outlive the context required to understand it.**

That gives the Cloudflare project a reason to exist well beyond the competition.
