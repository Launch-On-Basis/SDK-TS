import { BasisClient } from '../BasisClient';
import AMarketTradingArtifact from '../abis/AMarketTrading.json';
import ATokenFactoryArtifact from '../abis/ATokenFactory.json';
import IERC20Artifact from '../abis/IERC20.json';
import { Address, getAddress, keccak256, toBytes } from 'viem';

export class PredictionMarketsModule {
  private client: BasisClient;
  private marketTradingAddress: Address;

  constructor(client: BasisClient, marketTradingAddress: Address) {
    this.client = client;
    this.marketTradingAddress = marketTradingAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  /**
   * Returns the contract's minimum seed amount required to create a market,
   * in USDB wei (18 decimals). `createMarket` will revert if `seedAmount < minSeed`.
   */
  async getMinSeed(): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'minSeed',
    }) as Promise<bigint>;
  }

  /**
   * Helper to approve tokens for the MarketTrading contract
   */
  private async approveIfNeeded(tokenAddress: Address, amount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Wallet account is required for approval.");
    }
    
    const account = this.client.walletClient.account;

    // Check allowance
    const allowance = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: IERC20Artifact.abi,
      functionName: 'allowance',
      args: [account.address, this.marketTradingAddress],
    }) as bigint;

    if (allowance < amount) {
      const { request } = await this.client.publicClient.simulateContract({
        account,
        address: tokenAddress,
        abi: IERC20Artifact.abi,
        functionName: 'approve',
        args: [this.marketTradingAddress, amount],
      });

      const hash = await this.client.writeContract(request);
      await this.client.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  /**
   * Internal: creates a market on-chain. Use createMarketWithMetadata() instead.
   */
  private async createMarket(
    marketName: string,
    symbol: string,
    endTime: bigint,
    optionNames: string[],
    maintoken: Address,
    frozen: boolean,
    bonding: bigint,
    seedAmount: bigint = 0n
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Read the ecosystem's factory address and the contract's minSeed in parallel
    const [ecoData, minSeed] = await Promise.all([
      this.client.publicClient.readContract({
        address: this.marketTradingAddress,
        abi: AMarketTradingArtifact.abi,
        functionName: 'ecosystems',
        args: [maintoken],
      }) as Promise<any>,
      this.client.publicClient.readContract({
        address: this.marketTradingAddress,
        abi: AMarketTradingArtifact.abi,
        functionName: 'minSeed',
      }) as Promise<bigint>,
    ]);
    const factoryAddress = ecoData.factory ?? ecoData[0];
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    if (!factoryAddress || factoryAddress === ZERO_ADDRESS) {
      throw new Error(
        `Token ${maintoken} is not a registered ecosystem token — cannot create a market under it. Use an existing ecosystem token address as maintoken.`
      );
    }
    if (seedAmount < minSeed) {
      throw new Error(
        `seedAmount (${seedAmount}) is below the contract minimum (${minSeed} wei = ${Number(minSeed) / 1e18} USDB). Pass a larger seedAmount.`
      );
    }
    const feeAmount = await this.client.publicClient.readContract({
      address: factoryAddress,
      abi: ATokenFactoryArtifact.abi,
      functionName: 'feeAmount',
    }) as bigint;

    // Auto-approve USDB for seed amount if needed
    if (seedAmount > 0n) {
      await this.approveIfNeeded(this.client.usdbAddress, seedAmount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'createMarket',
      args: [marketName, symbol, endTime, optionNames, maintoken, frozen, bonding, seedAmount],
      value: feeAmount,
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    return { hash, receipt };
  }

  /**
   * Creates a prediction market and registers its metadata on IPFS in one call.
   * Requires SIWE authentication.
   *
   * Returns { hash, receipt, marketTokenAddress, imageUrl, metadata }
   * @param options.endTime - Unix timestamp in seconds
   * @param options.bonding - USDB amount in wei (18 decimals)
   * @param options.seedAmount - USDB amount in wei (18 decimals)
   */
  async createMarketWithMetadata(options: {
    marketName: string;
    symbol: string;
    endTime: bigint;
    optionNames: string[];
    maintoken?: Address;
    frozen?: boolean;
    bonding?: bigint;
    seedAmount?: bigint;
    description?: string;
    imageUrl?: string;
    imageFile?: Blob | Buffer;
    website?: string;
    telegram?: string;
    twitterx?: string;
  }) {
    // 0. Validate image up front — fail before spending gas
    if (!options.imageUrl && !options.imageFile) {
      throw new Error('Either imageUrl or imageFile is required.');
    }

    const maintoken = options.maintoken ?? this.client.mainTokenAddress;

    const createResult = await this.createMarket(
      options.marketName,
      options.symbol,
      options.endTime,
      options.optionNames,
      maintoken,
      options.frozen ?? false,
      options.bonding ?? 0n,
      options.seedAmount ?? 0n,
    );

    if (createResult.receipt.status === 'reverted') {
      throw new Error(`Market creation reverted (tx: ${createResult.hash})`);
    }

    // Parse market token from MarketCreated event
    const MARKET_CREATED_TOPIC = keccak256(toBytes('MarketCreated(address,address,address)'));
    const marketLog = createResult.receipt.logs.find(
      (l: any) => l.address.toLowerCase() === this.marketTradingAddress.toLowerCase() && l.topics[0] === MARKET_CREATED_TOPIC
    );

    let marketTokenAddress: Address;
    if (marketLog && marketLog.topics[1]) {
      marketTokenAddress = getAddress('0x' + marketLog.topics[1].slice(26)) as Address;
    } else {
      throw new Error('Could not extract market address from creation logs.');
    }

    // Upload image
    let imageUrl: string;
    if (options.imageFile) {
      imageUrl = await this.client.api.uploadImage(options.imageFile, `${marketTokenAddress}.webp`, 'token', marketTokenAddress);
    } else {
      imageUrl = await this.client.api.uploadImageFromUrl(options.imageUrl!, marketTokenAddress);
    }

    // Create metadata
    const metadata = await this.client.api.updateMetadata({
      address: marketTokenAddress,
      description: options.description,
      image: imageUrl,
      website: options.website,
      telegram: options.telegram,
      twitterx: options.twitterx,
    });

    // Sync the creation tx
    await this._syncTx(createResult.hash);

    return {
      hash: createResult.hash,
      receipt: createResult.receipt,
      marketTokenAddress,
      imageUrl,
      metadata,
    };
  }

  /**
   * Executes an AMM buy for a prediction outcome.
   * @param marketToken - market token address
   * @param outcomeId - outcome index
   * @param inputToken - input token address
   * @param inputAmount - input token amount in wei (18 decimals)
   * @param minUsdb - minimum USDB in wei (18 decimals)
   * @param minShares - minimum shares in wei (18 decimals)
   */
  async buy(
    marketToken: Address,
    outcomeId: number,
    inputToken: Address,
    inputAmount: bigint,
    minUsdb: bigint,
    minShares: bigint
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    await this.approveIfNeeded(inputToken, inputAmount);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'buy',
      args: [marketToken, outcomeId, inputToken, inputAmount, minUsdb, minShares],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Claims winnings after a market resolves.
   */
  async redeem(marketToken: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'redeem',
      args: [marketToken],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Reads the MarketData struct.
   */
  async getMarketData(marketToken: Address) {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getMarketData',
      args: [marketToken],
    });
  }

  /**
   * Reads the Outcome struct.
   */
  async getOutcome(marketToken: Address, outcomeId: number) {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getOutcome',
      args: [marketToken, outcomeId],
    });
  }

  /**
   * Reads user balances.
   */
  async getUserShares(marketToken: Address, user: Address, outcomeId: number) {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getUserShares',
      args: [marketToken, user, outcomeId],
    });
  }

  /**
   * Returns the initial reserves required for a given number of outcomes.
   */
  async getInitialReserves(numOutcomes: bigint): Promise<readonly [bigint, bigint]> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getInitialReserves',
      args: [numOutcomes],
    }) as Promise<readonly [bigint, bigint]>;
  }

  /**
   * Returns the number of outcomes for a market.
   */
  async getNumOutcomes(marketToken: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getNumOutcomes',
      args: [marketToken],
    }) as Promise<bigint>;
  }

  async getOptionNames(marketToken: Address): Promise<string[]> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getOptionNames',
      args: [marketToken],
    }) as Promise<string[]>;
  }

  async hasBettedOnMarket(marketToken: Address, user: Address): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'hasBettedOnMarket',
      args: [marketToken, user],
    }) as Promise<boolean>;
  }

  async getBountyPool(marketToken: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getBountyPool',
      args: [marketToken],
    }) as Promise<bigint>;
  }

  async getGeneralPot(marketToken: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getGeneralPot',
      args: [marketToken],
    }) as Promise<bigint>;
  }

  /**
   * @param usdbAmount - USDB amount in wei (18 decimals)
   */
  async getBuyOrderAmountsOut(marketToken: Address, orderId: bigint, usdbAmount: bigint) {
    return this.client.publicClient.readContract({
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'getBuyOrderAmountsOut',
      args: [marketToken, orderId, usdbAmount],
    });
  }

  /**
   * Buys from order book and AMM in a single transaction.
   * @param totalInput - input token amount in wei (18 decimals)
   * @param minShares - minimum shares in wei (18 decimals)
   */
  async buyOrdersAndContract(
    marketToken: Address,
    outcomeId: number,
    orderIds: bigint[],
    inputToken: Address,
    totalInput: bigint,
    minShares: bigint
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    await this.approveIfNeeded(inputToken, totalInput);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.marketTradingAddress,
      abi: AMarketTradingArtifact.abi,
      functionName: 'buyOrdersAndContract',
      args: [marketToken, outcomeId, orderIds, inputToken, totalInput, minShares],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    // Also sync order fills since this method fills P2P orders
    await this.client.api.syncOrder(hash, 'public');
    return { hash, receipt };
  }
}
