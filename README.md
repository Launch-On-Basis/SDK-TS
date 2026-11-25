# Basis SDK

TypeScript/JavaScript SDK for the Basis DeFi protocol on Robinhood Chain (chain id 4663).

Trading and cross swaps, token creation, leverage, loans, the vault, vesting, prediction markets (public and private hosts, order book, resolver), ERC-8004 agent identity and the REST API. Built on viem, designed for both humans and AI agents. The Python SDK ([SDK-PY](https://github.com/Launch-On-Basis/SDK-PY)) has the same methods in snake_case, with the same rules and defaults.

> **Status.** Version 0.2.0-beta.1, on Robinhood Chain (chain 4663). The paper site is live:
> `robinhoodPaper` carries its whole deployment, on play tokens, so try things there. The real site's contracts are zero
> in `robinhood` until its launch, so `robinhoodPaper` is the default.

## Requirements

- Node.js 18+, or a browser app built with a bundler (Vite, webpack 5, Next.js, esbuild, ...)
- A wallet private key or an injected viem `WalletClient` (for writes)

## Install

```bash
npm install github:Launch-On-Basis/SDK-TS
```

## Quick start

**Who can sign in.** The API signs in only a wallet linked to a BASIS account (on the website: X, Google or email,
then Account > Wallets) or a registered BASIS agent. A bot with a wallet of its own gets in with `agent`: `create()`
registers it and syncs it with a signed message (which accepts the BASIS Terms), then signs in. Any other wallet gets
`BasisApiError` 403 `wallet_not_linked`.

```typescript
import { BasisClient } from 'basis-sdk';

// Read-only: no key, no network calls in the constructor.
const reader = new BasisClient({ chain: 'robinhoodPaper', rpcUrl });   // 'robinhoodPaper' (default) | 'robinhood' | custom ChainConfig

// Full mode: checks the RPC chain id, SIWE login, provisions an API key (on client.apiKey; only a masked hint is logged).
const client = await BasisClient.create({
  chain: 'robinhoodPaper',
  privateKey: '0xYourPrivateKey',                     // a wallet linked to your BASIS account; or walletClient (below)
  // rpcUrl, apiKey, apiDomain, addresses (overrides win), slippageBps, sync,
  // contractsCheck: 'off' | 'warn' | 'strict', agent: true | AgentConfig,
  // onApiKeyCreated: (key) => store(key), apiTimeoutMs (30 s), apiUploadTimeoutMs (120 s), apiAiTimeoutMs (330 s)
});

// A bot's own new wallet: registers it as an ERC-8004 agent, syncs it, then signs in.
// A failed first sync throws AgentOnboardingError: run create() again, never agent.register().
const agentClient = await BasisClient.create({ chain: 'robinhoodPaper', privateKey: botKey, agent: { name: 'My bot' } });

// Contract-only: a signer without the API (no SIWE, no API key; key-only REST calls throw AuthRequiredError).
const bot = await BasisClient.create({ chain: 'robinhoodPaper', privateKey: '0x…', auth: false });
await bot.paper.claim();                              // play tUSDG on the paper site, once per wallet (also tNVDA, tETH)

// Mains: everything is per main. Amounts are raw units of the pair asset (its own decimals).
const main = await client.mains.default();            // { main, symbol, pairAsset, pairSymbol, pairDecimals, pairUnit, vault, … }
await client.trading.buy(main.main, 100n * main.pairUnit);     // minOut derived from a tax-inclusive quote (1%)
const price = await client.trading.getTokenPrice(main.main);   // Amount { raw, formatted, unit, asset, symbol, decimals }

// REST: raw JSON with camelCase keys.
const { data } = await client.api.getTokens({ limit: 20 });
```

Pass your own `rpcUrl` in production: Robinhood Chain's public RPC rate-limits after a few dozen calls. The API follows the
preset (`robinhoodPaper` uses `https://paper.launchonbasis.com`, never the real API); `apiDomain` overrides it. The custom-chain
form is a `ChainConfig`: `{ key, chain: defineChain({...}), rpcUrl, apiDomain, addresses }`.

## Injected wallets (Privy, Web3Auth, Magic, browser wallets, MPC)

Pass a viem `WalletClient` with an account set instead of `privateKey`. `create()` runs SIWE and API-key provisioning through it, and every module write uses it.

```typescript
import { createWalletClient, custom } from 'viem';

const walletClient = createWalletClient({ account: walletAddress, chain: robinhood, transport: custom(provider) });
const client = await BasisClient.create({ walletClient });
```

`privateKey` wins if both are given.

## Browser apps

The package has a browser build. Bundlers that read the `"browser"` export condition (Vite, webpack 5, Next.js client
code, esbuild `--platform=browser`, Rollup with `browser: true`) pick `dist/index.browser.mjs` from a plain
`import { BasisClient } from 'basis-sdk'`: no Node polyfills, no externals, nothing to configure. Its only dependency
is `viem`. Node keeps `dist/index.js` / `dist/index.mjs`, unchanged.

```typescript
import { BasisClient, robinhood } from 'basis-sdk';
import { createWalletClient, custom } from 'viem';

const [address] = await provider.request({ method: 'eth_requestAccounts' });   // MetaMask, Privy, any EIP-1193 wallet
const walletClient = createWalletClient({ account: address, chain: robinhood, transport: custom(provider) });
const client = await BasisClient.create({
  walletClient,
  apiKey: localStorage.getItem('basisKey') ?? undefined,       // a wallet has one key; the server shows it only once
  onApiKeyCreated: (key) => localStorage.setItem('basisKey', key),
});
```

- **Sign-in uses the browser's cookie.** In a page or web worker the client runs in browser cookie mode
  (`cookieMode: 'browser'`, detected; pass `'explicit'` to force the Node behaviour). The session cookie is HttpOnly, so
  the SDK never reads it: SIWE sign-in and session calls are sent with `credentials: 'include'`, the browser stores and
  sends the cookie, and the SDK learns the session state from the verify answer and `GET /api/auth/me`
  (`client.hasSession`, `client.refreshSession()`). `create()` reuses a session the browser already holds, so a page
  reload asks for no new signature. `client.sessionCookie` stays null.
- **Origin.** Browser sign-in needs the page and the API on one origin (`apiDomain` = the page's origin). The production
  API accepts SIWE messages for its own host only, answers `Access-Control-Allow-Origin: *` without
  `Access-Control-Allow-Credentials` and sets a `SameSite=Lax` cookie, so a page on another origin cannot hold a session
  there (the browser refuses the credentialed sign-in answer and `authenticate()` throws). Such a page still has public
  routes, on-chain writes with their sync, and an API key passed as `apiKey` (created where a session works).
- **Not in the browser:** the sync queue file (`sync.queueFile` throws `ValidationError('queueFile')`; queued syncs
  stay in `client.pendingSyncs` for `flushPendingSyncs()`). `downloadImage` / `uploadImageFromUrl` resize with the
  canvas instead of `sharp` (PNG where the browser cannot encode WebP; the image host must allow CORS).

## Modules

| Module | What it does |
|--------|-------------|
| `client.mains` | Registry of mains: pair asset, decimals, `PAIR_UNIT`, vault, trading state; `mainOf(token)` |
| `client.factory` | Create tokens (`createToken`, normal or reversed), presale state, prices in pair-asset units |
| `client.trading` | Buy/sell, tax-inclusive quotes, `quoteSwap` / `buildCrossPath` / `swapCross`, `mixedBuy`, buy-and-stake, one leverage position per token (open, add, extend, partial / full repay, `repayLeverageWith`) |
| `client.mainLens` | Read-only quotes that take the main first: main ↔ pair conversions, leverage count, partial-sell amounts |
| `client.hopExecutor` | Cross swaps: routes, limits and hop quotes (net of fees) |
| `client.taxes` | Base rate, creator/rewards fees with cooldowns, earnings per pair asset, referrals |
| `client.loans` | Loans made by the BASIS protocol (one per main and collateral): take, partial repay, `repayLoanWith`, extend, increase, partial sells, liquidation claims |
| `client.liquidation` | Liquidation views, leftover claims and the 365-day claim deadline |
| `client.referrals` | Set and read a referrer, referral counts |
| `client.paper` | Claim the paper site's test tokens (tUSDG, tNVDA, tETH); refuses on the real site |
| `client.vault` | Stake, unstake, claim, compound, borrow against a position, full repay |
| `client.vesting` | Vesting schedules, `getVestingsOf`, loans on vested tokens, renounce, repay-extend-reborrow |
| `client.leverageSimulator` | Leverage, loan and floor simulations (pure reads). A floor is measured in the pair asset, and the pair asset itself can move |
| `client.marketReader` | Bet quotes, live market state, redeemables, sliced redemption plans |
| `client.predictionMarkets` | Public host: gated create, `checkBuy`, buy with any accepted input token (with a deadline), redeem |
| `client.privateMarkets` | Private host: voter panels, ranked votes, finalize window |
| `client.orderBook` | Limit orders on market shares (both hosts, with `maxCost` and an AMM sweep) |
| `client.resolver` | Ranked propose/dispute/veto/vote with bonds, status helper, ranking keys |
| `client.updown` | Up/Down rounds: not enabled yet |
| `client.agent` | ERC-8004 agent identity on the chain's registry: register, the signed first sync (`syncSigned`), update. `create({ agent })` onboards a new agent wallet |
| `client.api` | REST API, one wrapper per route (see below) |

`client.getClaimables()` reads everything a wallet can claim (holder rewards, market redemptions, vesting, vault rewards) from the chain in one call. Every public method has a doc comment with its rules and errors.

## REST layer (`client.api`)

Wrappers for the API's OpenAPI spec, in ten domains: auth, content, tokens, markets, credit, wallet, updown, discovery, social, sync (`src/api/*.ts`). Answers are the raw JSON (camelCase keys; amounts as `RawAmount` decimal strings beside their asset and decimals; USD only as nullable `UsdE18` strings with `usdSource`). A non-2xx answer throws `BasisApiError(status, code, message, body, retryAfter)`; a call that needs a key or session throws `AuthRequiredError` before any request. Every call has a deadline that covers the body (`apiTimeoutMs`, default 30 s; uploads 120 s; AI routes 330 s; per call `client.api.withOptions({ timeoutMs, signal })`): past it `BasisApiError` with status 0 and code `timeout`. The REST layer never retries. With a session and a signer, requests send `X-Wallet-Address` so a multi-wallet session acts for the signer; the session goes only for a signer whose wallet the SDK confirmed in it (`client.sessionWallets`), so after switching the signer call `client.authenticate()` (else `AuthRequiredError` before sending). Public and key-only calls carry no session (browser: `credentials: 'omit'`). `client.api.paginate(fn, params)` walks cursor-paged lists. AI market drafts can run in the background (`async: true`, or `client.api.runDraftJob(kind, params)`): the API cuts one drafting request at about 24 s. Reads the API no longer serves (quotes, routes, live market and Up/Down state, claimables) come from the chain through the modules above.

## Key behaviours

- **Every write syncs.** Each write simulates first (reverts are decoded into `BasisContractError` with the contract's reason), sends, waits for the receipt and awaits one `POST /api/v1/sync {txHash, source: "sdk"}`, order-book writes included. Failed syncs are retried (6 attempts with backoff; a 429 waits on `X-RateLimit-Reset`), then queued in `client.pendingSyncs` for `flushPendingSyncs()`. A sync failure never throws: the transaction is already confirmed.
- **Never a zero minimum.** `minOut`, `minShares` and `maxCost` are derived from a tax-inclusive quote with the client slippage (1% trades, markets and redeem), overridable per call with `slippageBps` or an explicit value.
- **Deadlines.** `swapCross`, `repayLeverageWith`, `repayLoanWith` and market `buy` default to latest block + 600 s.
- **Units with metadata.** Prices and values are `Amount` objects in the pair asset's units (scaled by `PAIR_UNIT`, not always 18 decimals, not USD). Raw `bigint` arguments are raw units; `number` / `string` amounts are human amounts.
- **Pre-checks.** Conditions the contract checks without a message throw `ValidationError(rule, …)` before any gas is spent.
- **Approvals** are sent only when the allowance is short: the trading router gets a one-time unlimited approval for the token traded, every other spender the exact amount. They sync like every other write.
- **One write at a time.** Await each write before the next from the same client. With a private key, a nonce another transaction took throws `BasisRpcError` kind `nonce_used`: nothing ran, so sending again is fine.
- **Deployment checks.** `client.<module>.deployed` reports a zero address; `contractsCheck` compares the chain id and the deployment with the site's `/contracts.json`. The sites publish no addresses: the SDK's address book is the source.
- **No gas sponsorship.** Transactions pay gas normally.
- **Bundled creation**: `createTokenWithMetadata` and `createMarketWithMetadata` create the token or market, then upload its image and IPFS metadata. The image argument and the credentials are checked before any gas. An upload that fails after the create does not throw (the tx is confirmed): the result carries `uploadError` (`{ stage, code, status, message }`, the failed step's field null) and a `warnings` entry; finish with `factory.retryTokenMetadata(token, ...)` / `predictionMarkets.retryMarketMetadata(market, ...)` (no tx), never by creating again.
- **Builds**: ESM and CJS for Node, an ESM browser build (`"browser"` export), TypeScript declarations; ABIs are typed `as const`, so viem checks function names and arguments at build time. The exported ABIs hold only the functions and events the SDK itself uses.

## Links

- Platform: https://launchonbasis.com
- API reference: https://launchonbasis.com/api-docs
- Report a bug: https://launchonbasis.com/bugreport, or `client.api.submitBugReport(...)`

## License

Elastic License 2.0 (ELv2): free to use, modify, and distribute. Build commercial products with it. Just don't resell the SDK itself as a hosted service. See [LICENSE](LICENSE) for details.
