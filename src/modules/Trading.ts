import { BasisClient } from '../BasisClient';
import ASwapArtifact from '../abis/ASwap.json';
import IERC20Artifact from '../abis/IERC20.json';
import FactoryTokenArtifact from '../abis/FACTORYTOKEN.json';
import { Address, getAddress, getContract } from 'viem';

// Inline ABI for leverage view functions on MAINTOKEN (not in compiled artifact)
const leverageAbi = [
  {"inputs":[{"name":"","type":"address"}],"name":"leverageCount","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"","type":"address"},{"name":"","type":"uint256"}],"name":"leverages","outputs":[{"name":"user","type":"address"},{"name":"token","type":"address"},{"name":"collateralAmount","type":"uint256"},{"name":"liquidatedAmount","type":"uint256"},{"name":"fullAmount","type":"uint256"},{"name":"borrowedAmount","type":"uint256"},{"name":"liquidationTime","type":"uint256"},{"name":"liquidationClaim","type":"uint256"},{"name":"isLiquidated","type":"bool"},{"name":"active","type":"bool"},{"name":"creationTime","type":"uint256"},{"name":"timeOfClosure","type":"uint256"},{"name":"leverage","type":"tuple","components":[{"name":"leverageBuyAmount","type":"uint256"},{"name":"cashedOut","type":"uint256"}]}],"stateMutability":"view","type":"function"},
] as const;

export class TradingModule {
  private client: BasisClient;
  private swapAddress: Address;

  constructor(client: BasisClient, swapAddress: Address) {
    this.client = client;
    this.swapAddress = swapAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  /**
   * Automatically approves the token to be spent by the SWAP contract.
   * Internal helper function.
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
      args: [account.address, this.swapAddress],
    }) as bigint;

    if (allowance < amount) {
      const { request } = await this.client.publicClient.simulateContract({
        account,
        address: tokenAddress,
        abi: IERC20Artifact.abi,
        functionName: 'approve',
        args: [this.swapAddress, amount],
      });

      const hash = await this.client.writeContract(request);
      await this.client.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  /**
   * Buys tokens during the bonding curve phase.
   * Calls buyTokens on SWAP.sol.
   * @param amount — input token amount in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   * @param wrapTokens — whether to wrap output tokens
   */
  async buyBondingTokens(amount: bigint, minOut: bigint, path: Address[], wrapTokens: boolean) {
    return this.buyTokens(amount, minOut, path, wrapTokens);
  }

  /**
   * Sells tokens during the bonding curve phase.
   * Calls sellTokens on SWAP.sol.
   * @param amount — token amount to sell in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   * @param swapToETH — whether to unwrap output to native ETH
   */
  async sellBondingTokens(amount: bigint, minOut: bigint, path: Address[], swapToETH: boolean) {
    return this.sellTokens(amount, minOut, path, swapToETH);
  }

  /**
   * General buy tokens function.
   * @param amount — input token amount in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   * @param wrapTokens — whether to wrap output tokens
   */
  async buyTokens(amount: bigint, minOut: bigint, path: Address[], wrapTokens: boolean) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const account = this.client.walletClient.account;

    // Approve the input token (path[0])
    if (path.length > 0) {
        await this.approveIfNeeded(path[0], amount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account,
      address: this.swapAddress,
      abi: ASwapArtifact.abi,
      functionName: 'buyTokens',
      args: [amount, minOut, path, wrapTokens],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * General sell tokens function.
   * @param amount — token amount to sell in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   * @param swapToETH — whether to unwrap output to native ETH
   */
  async sellTokens(amount: bigint, minOut: bigint, path: Address[], swapToETH: boolean) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const account = this.client.walletClient.account;

    // Approve the input token (path[0]) which is the token being sold
    if (path.length > 0) {
        await this.approveIfNeeded(path[0], amount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account,
      address: this.swapAddress,
      abi: ASwapArtifact.abi,
      functionName: 'sellTokens',
      args: [amount, minOut, path, swapToETH],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Simplified buy: purchases the target token using USDB.
   * Automatically builds the correct swap path.
   * @param tokenAddress — address of the token to buy
   * @param usdbAmount — USDB amount in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param wrapTokens — whether to wrap output tokens
   */
  async buy(tokenAddress: Address, usdbAmount: bigint, minOut: bigint = 0n, wrapTokens: boolean = false) {
    const path = this.buildBuyPath(tokenAddress);
    return this.buyTokens(usdbAmount, minOut, path, wrapTokens);
  }

  /**
   * Simplified sell: sells a token.
   * For factory tokens, set toUsdb=true to swap all the way to USDB (3-hop),
   * or false to stop at MAINTOKEN (2-hop). Ignored when selling MAINTOKEN.
   * @param tokenAddress — address of the token to sell
   * @param amount — token amount to sell in wei (18 decimals)
   * @param toUsdb — whether to swap all the way to USDB
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param swapToETH — whether to unwrap output to native ETH
   */
  async sell(tokenAddress: Address, amount: bigint, toUsdb: boolean = false, minOut: bigint = 0n, swapToETH: boolean = false) {
    const path = this.buildSellPath(tokenAddress, toUsdb);
    return this.sellTokens(amount, minOut, path, swapToETH);
  }

  private buildBuyPath(tokenAddress: Address): Address[] {
    const usdb = getAddress(this.client.usdbAddress);
    const mainToken = getAddress(this.client.mainTokenAddress);
    const target = getAddress(tokenAddress);

    if (target === mainToken) {
      return [usdb, mainToken];
    }
    return [usdb, mainToken, target];
  }

  private buildSellPath(tokenAddress: Address, toUsdb: boolean): Address[] {
    const usdb = getAddress(this.client.usdbAddress);
    const mainToken = getAddress(this.client.mainTokenAddress);
    const target = getAddress(tokenAddress);

    if (target === mainToken) {
      return [mainToken, usdb];
    }
    if (toUsdb) {
      return [target, mainToken, usdb];
    }
    return [target, mainToken];
  }

  /**
   * Leveraged buy: purchases tokens with leverage (creates a loan position).
   * @param amount — USDB collateral amount in wei (18 decimals)
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   * @param numberOfDays — loan duration in days, integer, minimum 10
   */
  async leverageBuy(amount: bigint, minOut: bigint, path: Address[], numberOfDays: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const account = this.client.walletClient.account;

    // Approve USDB for the swap contract
    if (path.length > 0) {
      await this.approveIfNeeded(path[0], amount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account,
      address: this.swapAddress,
      abi: ASwapArtifact.abi,
      functionName: 'leverageBuy',
      args: [amount, minOut, path, numberOfDays],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Partially sells collateral from a loan/leverage position.
   * percentage must be divisible by 10 (10-100).
   * @param loanId — ID of the loan/leverage position
   * @param percentage — integer 10-100, divisible by 10
   * @param isLeverage — true if leverage position, false if loan
   * @param minOut — minimum output amount in wei (18 decimals)
   */
  async partialLoanSell(loanId: bigint, percentage: bigint, isLeverage: boolean, minOut: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.swapAddress,
      abi: ASwapArtifact.abi,
      functionName: 'partialLoanSell',
      args: [loanId, percentage, isLeverage, minOut],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Sells a percentage of the user's token balance.
   * @param tokenAddress — address of the token to sell
   * @param percentage — integer 1-100
   * @param toUsdb — whether to swap all the way to USDB
   * @param minOut — minimum output amount in wei (18 decimals)
   * @param swapToETH — whether to unwrap output to native ETH
   */
  async sellPercentage(tokenAddress: Address, percentage: number, toUsdb: boolean = false, minOut: bigint = 0n, swapToETH: boolean = false) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }
    if (percentage < 1 || percentage > 100) {
      throw new Error("Percentage must be between 1 and 100.");
    }

    const account = this.client.walletClient.account;

    // Read current balance
    const balance = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: IERC20Artifact.abi,
      functionName: 'balanceOf',
      args: [account.address],
    }) as bigint;

    if (balance === 0n) {
      throw new Error("Token balance is zero.");
    }

    const sellAmount = (balance * BigInt(percentage)) / 100n;
    return this.sell(tokenAddress, sellAmount, toUsdb, minOut, swapToETH);
  }

  /**
   * Gets the leverage position count for a user from MAINTOKEN.
   */
  async getLeverageCount(user: Address) {
    const count = await this.client.publicClient.readContract({
      address: this.client.mainTokenAddress,
      abi: leverageAbi,
      functionName: 'leverageCount',
      args: [user],
    }) as bigint;
    return count;
  }

  /**
   * Gets a specific leverage position from MAINTOKEN.
   */
  async getLeveragePosition(user: Address, loanId: bigint) {
    return this.client.publicClient.readContract({
      address: this.client.mainTokenAddress,
      abi: leverageAbi,
      functionName: 'leverages',
      args: [user, loanId],
    });
  }

  /**
   * Fetches the token price from the token's contract.
   */
  async getTokenPrice(tokenAddress: Address) {
    const price = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: FactoryTokenArtifact.abi,
      functionName: 'getTokenPrice',
    }) as bigint;
    
    return price.toString();
  }

  /**
   * Fetches the USD price of the token from the token's contract.
   */
  async getUSDPrice(tokenAddress: Address) {
    const price = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: FactoryTokenArtifact.abi,
      functionName: 'getUSDPrice',
    }) as bigint;

    return price.toString();
  }

  /**
   * Returns the expected output amounts for a given input amount and swap path.
   * @param amount — input token amount in wei (18 decimals)
   * @param path — ordered list of token addresses for the swap route
   */
  async getAmountsOut(amount: bigint, path: Address[]): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.swapAddress,
      abi: ASwapArtifact.abi,
      functionName: 'getAmountsOut',
      args: [amount, path],
    }) as Promise<bigint>;
  }
}
