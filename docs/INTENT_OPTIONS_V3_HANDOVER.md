# Intent Options V3: Engineering Handover

Last updated: 2026-11-16

## 1. Project

- **Name:** Intent-Based Options Builder (Intent Options V3)
- **Live deployment:** https://intent-options-v3.onrender.com/
- **Repository:** https://github.com/Imdavid21/finance-platform
- **Handover branch:** `render-intent-options-20261007`
- **Deployment date recorded in project notes:** 2026-10-07
- **Network status:** Testnet only. Mainnet execution was not approved or verified.

This document consolidates the project state recorded during the October 2026 build and the repository checks performed for this handover. It distinguishes reported implementation status from items that still need direct verification.

## 2. Product scope

Intent Options V3 is an intent-driven options strategy builder for Derive. The intended user flow is:

1. Load live testnet instruments and market data.
2. Configure an options strategy using the strategy builder.
3. Compile the selected legs into a strategy representation.
4. Review the proposed trade, payoff and margin implications.
5. Request an RFQ quote and proceed through the testnet execution flow.

The recorded implementation includes a bull call spread strategy compiler and interactive strategy configuration controls.

## 3. Recorded implementation

The October 7 build notes report the following:

- React and TypeScript application.
- Official Derive V3 TypeScript SDK integration (`@derivexyz/derive-ts`).
- Derive REST access through a Render-hosted gateway.
- A separate WebSocket client for streaming market data.
- Instrument, ticker, spot and expiry data integration.
- Bull call spread strategy compilation.
- RFQ quote and execution flow.
- Wallet connection and session-key flow.
- Margin simulation.
- Trade review and payoff visualisation.
- Retry and timeout handling for network requests.
- Responsive layout fixes, including Safari and mobile adjustments.

These are historical build notes, not a fresh end-to-end verification of the live application.

## 4. Test and build status

The recorded October 7 verification reported:

- Production build passed.
- Strategy test suite: 4 of 4 tests passed.
- Zero reported dependency vulnerabilities at that checkpoint.
- Application deployed on Render.

No fresh build, test run, wallet transaction or RFQ execution was performed as part of this documentation update. Re-run the current repository's actual scripts before treating these results as current.

## 5. Architecture and integration boundaries

The recorded integration split is:

- **Frontend:** React + TypeScript.
- **Derive SDK:** Official Derive V3 TypeScript SDK.
- **REST:** Requests routed through a Render gateway.
- **Streaming:** Separate WebSocket connection for market updates.
- **Trading workflow:** Strategy compilation, review, RFQ quote and testnet execution.
- **Wallet:** Wallet connection and session-key support.

The exact module paths, gateway routes, environment variable names, API payload schemas and deployment service settings have not been confirmed in this handover. Inspect the source and Render service configuration before making changes to these boundaries.

## 6. Repository audit warning

A repository inspection on 2026-11-16 found a documentation/source mismatch that must be resolved before another engineer relies on this repository as the complete source of truth:

- The repository is `Imdavid21/finance-platform`.
- The branch `render-intent-options-20261007` exists.
- The branch's root `README.md` still describes an older Finance SaaS Platform.
- The branch's root `package.json` identifies a Next.js 14 application named `finance-platform`, with scripts such as `next dev -p 4000` and `next build`.
- A root-level `vite.config.ts` was not found.

This does not establish whether the Intent Options V3 source lives in a subdirectory, whether the Render service is connected to another repository/ref, or whether the historical repository/branch details were recorded incorrectly. **Do not assume this repository branch is the complete deployable source until this discrepancy is reconciled.**

## 7. Outstanding engineering work

The following items were recorded as incomplete or requiring further validation:

1. Complete funded-wallet end-to-end testing on Derive testnet.
2. Validate private/session-key execution paths with a funded test account.
3. Improve and test RFQ failure, expiry, rejection and retry handling.
4. Add or complete portfolio and open-position visibility.
5. Refine probability and payoff calculations.
6. Complete interaction and mobile QA across supported browsers.
7. Verify loading, empty, success and error state transitions.
8. Run adversarial execution tests, including stale quotes, changed market conditions, insufficient margin, wallet rejection and network interruption.

Prioritise testnet safety and execution correctness before considering any mainnet work.

## 8. Security and operational requirements

- Keep the application testnet-only until mainnet support is explicitly reviewed and approved.
- Never commit private keys, seed phrases, API secrets, session keys, wallet credentials or production environment files.
- Use Render environment variables for secrets. Document variable names and purpose, never values.
- Do not log authentication tokens, signatures or sensitive wallet material.
- Validate quote freshness and execution parameters immediately before signing or submitting.
- Treat margin estimates as estimates. Reconcile them against Derive's authoritative response.
- Add clear user-facing errors for failed, expired or rejected RFQs.
- Confirm chain/network identity before enabling wallet actions.

## 9. Handover checklist

### Repository and deployment
- [ ] Confirm the exact repository and branch connected to the live Render service.
- [ ] Locate the actual V3 application root and reconcile the root README/package mismatch.
- [ ] Record the correct install, development, build, test and lint commands.
- [ ] Document the Render service, gateway service, domains, health checks and deploy trigger.
- [ ] List required environment variable names and safe descriptions.

### Application
- [ ] Map the frontend routes and major components.
- [ ] Document the Derive REST endpoints and WebSocket subscription lifecycle.
- [ ] Document strategy compiler input/output schemas.
- [ ] Document wallet and session-key lifecycle.
- [ ] Document RFQ state transitions and execution error handling.

### Quality and release
- [ ] Run a clean install, production build, lint and all tests.
- [ ] Run funded-wallet testnet E2E tests.
- [ ] Verify mobile and browser behaviour.
- [ ] Verify no secrets or sensitive artifacts are tracked by Git.
- [ ] Confirm testnet-only safeguards in both UI and execution layer.

## 10. Local setup

The exact V3 application directory and current package scripts were not verified during this handover because of the repository mismatch described above. Do not use generic setup commands as authoritative until the application root is confirmed.

Once the correct application root is identified:

1. Clone the confirmed repository.
2. Check out the confirmed deployment branch/ref.
3. Read its package manifest and environment example.
4. Install dependencies using the lockfile's package manager.
5. Configure local testnet environment variables without committing secrets.
6. Run the documented development, test and production build commands.

## 11. Change history

- **2026-10-07:** Intent Options V3 build and Render deployment recorded. Historical notes report a passing production build and 4/4 strategy tests.
- **2026-11-16:** Handover document added. Repository audit identified a mismatch between the V3 build notes and the branch's root README/package manifest. The mismatch is explicitly left open rather than guessed at.

## 12. Immediate next step

Resolve the source-of-truth mismatch first. Confirm the Render service's connected GitHub repository, branch, commit and root directory, then compare that exact commit with this repository branch. Only after that should this handover be expanded with verified file paths, commands, environment variables and endpoint contracts.
