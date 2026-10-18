# ADR 001: Use a lightweight control plane with pinned engine adapters

Status: accepted

Date: 2026-10-18

## Context

GeoEvidence Studio already provides GEO query, sample, citation and measurement capabilities. WorkLoom-video-edit already provides graphic, video, editing, talking-head and delivery capabilities. Both are larger WorkLoom-derived applications with their own runtime, dependency and release cycles.

The missing capability is not another media engine. It is a personal control plane that keeps one set of claims, approvals, receipts and observations across every channel.

## Options

### Option A: Fork both projects into one monorepo

This provides the most files at the start but duplicates application shells, increases dependency and security surface, and makes upgrades expensive.

### Option B: Light control plane plus adapters

This keeps one private product with explicit domain objects and contract tests. Upstreams remain independently versioned.

### Option C: Rewrite every engine

This produces the cleanest conceptual model but discards tested collection, editing and delivery behavior.

## Decision

Use Option B.

The personal repository owns the entity, claims, content graph, approval policy, external receipts, interaction classification and GEO observations. Adapters call specialized engines through pinned contracts. The first version copies no upstream source code.

## Consequences

- Setup is small and auditable.
- The first useful milestone can ship without an AI key or platform credential.
- Adapter contracts and contract tests must be maintained.
- Privacy and evidence checks stay central even when engines change.
- A private repository remains a control plane, not a public GEO source.
