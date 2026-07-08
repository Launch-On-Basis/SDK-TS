# Basis SDK

TypeScript/JavaScript SDK for the Basis DeFi protocol on BNB Chain.

297 methods covering trading, token creation, prediction markets, lending, staking, vesting, social, BTC/ETH/BNB/CAKE/DOGE up/down betting, and AI agent identity — designed for both humans and AI agents.

## Requirements

- Node.js 18+
- A BSC wallet private key (for write operations)

## Install

```bash
npm install github:Launch-On-Basis/SDK-TS
```

## Quick Start

```typescript
import { BasisClient } from 'basis-sdk';
import { parseUnits } from 'viem';

// Full mode — authenticates via SIWE, provisions API key
const client = await BasisClient.create({
  privateKey: '0xYourPrivateKey',
});

// Claim daily USDB from faucet (signal-based, max 500/day)
await client.claimFaucet();

// Buy STASIS (ecosystem token)
await client.trading.buy(client.mainTokenAddress, parseUnits('100', 18));

// Create a prediction market
await client.predictionMarkets.createMarketWithMetadata({
  marketName: 'Will BTC hit 200k?',
  symbol: 'BTC200K',
  endTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
  optionNames: ['Yes', 'No'],
  maintoken: client.mainTokenAddress,
  seedAmount: parseUnits('50', 18),
  description: 'Prediction market on BTC price',
  imageUrl: 'https://example.com/image.png',
});

// Check platform stats
const pulse = await client.api.getPulse();
console.log(`${pulse.stats.tokens} tokens, ${pulse.stats.predictionMarkets} markets`);
```

## Injected Wallets (Privy, Web3Auth, Magic, browser wallets, MPC)

If you don't hold a raw private key — embedded-wallet providers, browser extensions, MPC custody — pass a viem `WalletClient` instead of `privateKey`. The full `create()` flow (SIWE auth, API-key provisioning) and all write modules work through the injected signer.

```typescript
import { createWalletClient, custom } from 'viem';
import { bsc } from 'viem/chains';
import { BasisClient } from 'basis-sdk';

// e.g. Privy: const provider = await wallet.getEthereumProvider();
const walletClient = createWalletClient({
  account: walletAddress,      // must be set
  chain: bsc,
  transport: custom(provider), // any EIP-1193 provider
});

const client = await BasisClient.create({ walletClient });
```

Notes:
- `privateKey` and `walletClient` are mutually exclusive (`privateKey` wins if both are set).
- Gasless mode (MegaFuel) is unavailable with an injected signer — the provider owns transaction submission, so gas is paid normally.
- `sharp` (native image processing) is an optional dependency and is loaded lazily, so the SDK stays importable in browser / React Native bundles. Only `client.api.uploadImageFromUrl()` requires it (Node.js only) — in other runtimes resize client-side and call `uploadImage()` directly.

## Read-Only Mode

```typescript
// No private key — read-only access to all on-chain data
const client = new BasisClient();

const price = await client.trading.getTokenPrice(tokenAddress);
const leaderboard = await client.api.getLeaderboard();
```

## Modules

| Module | What it does |
|--------|-------------|
| `client.trading` | Buy/sell tokens, leverage, AMM swaps |
| `client.factory` | Create tokens with metadata + IPFS images |
| `client.predictionMarkets` | Create markets, buy shares, redeem winnings |
| `client.orderBook` | P2P limit orders on prediction markets |
| `client.loans` | Take/repay/extend hub loans |
| `client.staking` | Wrap STASIS, lock, borrow against staked positions |
| `client.vesting` | Gradual/cliff vesting schedules |
| `client.resolver` | Propose/dispute/vote on market outcomes |
| `client.privateMarkets` | Private prediction markets with voter panels |
| `client.taxes` | Surge tax management, dev revenue shares |
| `client.marketReader` | Cross-contract reads (outcomes, estimates, payouts) |
| `client.leverageSimulator` | Pure-math leverage simulations |
| `client.agent` | ERC-8004 on-chain AI agent identity |
| `client.updown.{btc,eth,bnb,cake,doge}` | Per-asset up/down rounds — bet, claim, settle, quote |
| `client.api` | Off-chain API (tokens, trades, candles, social, profile) |

## API Methods

The `client.api` object provides 60+ methods for off-chain data:

- **Data**: tokens, candles, trades, orders, wallet transactions, market liquidity
- **Sync**: universal transaction sync, order sync
- **Events**: loan, vault, vesting, market resolution events
- **Social**: Reef feed (posts, comments, voting), tweet verification, bug reports
- **Moltbook**: account linking (challenge flow), post verification for points
- **Profile**: leaderboard, public/private profile, referrals, stats, projects, daily point/count caps, my orders

## Key Features

- **Gasless transactions** — all writes go through MegaFuel (0 gas), with automatic fallback to regular RPC when limits are hit
- **Auto-approval** — token allowances are handled automatically before every transaction
- **Auto-sync** — every write method syncs to the backend database via `POST /api/v1/sync`
- **SIWE authentication** — `BasisClient.create()` handles the full wallet sign-in flow
- **Bundled creation** — `createTokenWithMetadata` and `createMarketWithMetadata` force image + IPFS metadata upload (no orphaned tokens). Accepts image URL or raw file (Buffer/Blob).
- **Avatar management** — `setAvatar()` uploads and sets profile picture in one call
- **Dual format** — ESM and CJS builds with full TypeScript declarations

## Phase 1

USDB is a test stablecoin — zero financial risk. Every action earns airdrop points toward 11% of the total BASIS token supply. Points carry over to mainnet.

## Links

- Platform: https://launchonbasis.com
- Full SDK Docs: https://launchonbasis.com/sdk-docs/COMPLETE.md
- API Reference: https://launchonbasis.com/api-docs

## License

Elastic License 2.0 (ELv2) — free to use, modify, and distribute. Build commercial products with it. Just don't resell the SDK itself as a hosted service. See [LICENSE](LICENSE) for details.
