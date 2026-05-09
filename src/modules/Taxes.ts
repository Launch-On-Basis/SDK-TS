import { BasisClient } from '../BasisClient';
import ATaxesArtifact from '../abis/ATaxes.json';
import { Address } from 'viem';

export class TaxesModule {
  private client: BasisClient;
  private taxesAddress: Address;

  constructor(client: BasisClient, taxesAddress: Address) {
    this.client = client;
    this.taxesAddress = taxesAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  /**
   * Returns the dev's accumulated USDB earnings on a specific token, in 18-dec wei.
   *
   * The Up/Basis tax model is push-based: tokens accrue dev tax to this counter,
   * and when `distributeTax(token)` fires (called internally on contract events),
   * the accumulated amount is paid out to the dev wallets per their basis-point
   * shares. This getter reads the un-distributed accrued balance.
   *
   * @param token - token contract address
   * @param dev - dev wallet address
   * @returns accumulated unpaid USDB earnings, 18-dec wei
   */
  async getCreatorEarnings(token: Address, dev: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'tokenDevEarnings',
      args: [token, dev],
    }) as Promise<bigint>;
  }

  /**
   * Returns the dev's lifetime distributed earnings across every token they
   * have a share on, in 18-dec USDB wei. This is the cumulative paid-out total,
   * not the un-distributed accrual — for that, use `getCreatorEarnings(token, dev)`
   * per token.
   *
   * @param dev - dev wallet address
   * @returns lifetime paid-out USDB earnings, 18-dec wei
   */
  async getDevTotalEarnings(dev: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'devTotalEarnings',
      args: [dev],
    }) as Promise<bigint>;
  }

  /**
   * Returns the effective tax rate (in basis points) for a specific token and user.
   * @param token - token contract address
   * @param user - user wallet address
   */
  async getTaxRate(token: Address, user: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'getTaxRate',
      args: [token, user],
    }) as Promise<bigint>;
  }

  /**
   * Returns the current surge tax rate (in basis points) for a token.
   * @param token - token contract address
   */
  async getCurrentSurgeTax(token: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'getCurrentSurgeTax',
      args: [token],
    }) as Promise<bigint>;
  }

  /**
   * Returns the available surge quota for a token.
   * @param token - token contract address
   */
  async getAvailableSurgeQuota(token: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'availableSurgeQuota',
      args: [token],
    }) as Promise<bigint>;
  }

  /**
   * Returns all four base tax rates.
   */
  async getBaseTaxRates() {
    const [stasis, stable, defaultRate, prediction] = await Promise.all([
      this.client.publicClient.readContract({
        address: this.taxesAddress,
        abi: ATaxesArtifact.abi,
        functionName: '_taxRateStasis',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.taxesAddress,
        abi: ATaxesArtifact.abi,
        functionName: '_taxRateStable',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.taxesAddress,
        abi: ATaxesArtifact.abi,
        functionName: '_taxRateDefault',
      }) as Promise<bigint>,
      this.client.publicClient.readContract({
        address: this.taxesAddress,
        abi: ATaxesArtifact.abi,
        functionName: '_taxRatePrediction',
      }) as Promise<bigint>,
    ]);

    return { stasis, stable, default: defaultRate, prediction };
  }

  /**
   * Start a decaying surge tax on a factory token. Only callable by the token's DEV.
   * @param startRate - basis points (0-10000)
   * @param endRate - basis points (0-10000)
   * @param duration - duration in seconds
   * @param token - token contract address
   */
  async startSurgeTax(startRate: bigint, endRate: bigint, duration: bigint, token: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required.");
    }
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'startSurgeTax',
      args: [startRate, endRate, duration, token],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * End an active surge tax early. Only callable by the token's DEV.
   * @param token - token contract address
   */
  async endSurgeTax(token: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required.");
    }
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'endSurgeTax',
      args: [token],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Add a developer revenue share wallet for a token. Only callable by the token's DEV.
   * @param token - token contract address
   * @param wallet - revenue share recipient address
   * @param basisPoints - basis points (0-10000)
   */
  async addDevShare(token: Address, wallet: Address, basisPoints: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required.");
    }
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'addDevShare',
      args: [token, wallet, basisPoints],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Remove a developer revenue share wallet. Only callable by the token's DEV.
   * @param token - token contract address
   * @param wallet - revenue share recipient address
   */
  async removeDevShare(token: Address, wallet: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required.");
    }
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.taxesAddress,
      abi: ATaxesArtifact.abi,
      functionName: 'removeDevShare',
      args: [token, wallet],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }
}
