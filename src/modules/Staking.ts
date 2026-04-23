import { BasisClient } from '../BasisClient';
import AStasisVaultArtifact from '../abis/AStasisVault.json';
import ALoanHubArtifact from '../abis/ALOAN_HUB.json';
import IMainCoreArtifact from '../abis/IMAIN_CORE.json';
import IERC20Artifact from '../abis/IERC20.json';
import { Address } from 'viem';

export class StakingModule {
  private client: BasisClient;
  private stakingAddress: Address;

  constructor(client: BasisClient, stakingAddress: Address) {
    this.client = client;
    this.stakingAddress = stakingAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  /** Reads the caller's active staking loan: { hubId, loanHubAddress }. Throws if none. */
  private async _getActiveStakingLoan(user: Address): Promise<{ hubId: bigint; loanHubAddress: Address }> {
    const vault = await this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'userVaults',
      args: [user],
    }) as readonly [bigint, bigint, bigint, boolean];
    const hubId = vault[2];
    const hasActiveLoan = vault[3];
    if (!hasActiveLoan) throw new Error('No active staking loan for this wallet.');

    const loanHubAddress = await this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'loanHub',
    }) as Address;

    return { hubId, loanHubAddress };
  }

  private async approveIfNeeded(tokenAddress: Address, spender: Address, amount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Wallet account is required for approval.");
    }
    const account = this.client.walletClient.account;
    const allowance = await this.client.publicClient.readContract({
      address: tokenAddress,
      abi: IERC20Artifact.abi,
      functionName: 'allowance',
      args: [account.address, spender],
    }) as bigint;

    if (allowance < amount) {
      const { request } = await this.client.publicClient.simulateContract({
        account,
        address: tokenAddress,
        abi: IERC20Artifact.abi,
        functionName: 'approve',
        args: [spender, amount],
      });
      const hash = await this.client.writeContract(request);
      await this.client.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  /**
   * Wraps STASIS (MAINTOKEN) into wSTASIS.
   * Approves the staking contract to spend MAINTOKEN if needed.
   * @param amount - STASIS amount in wei (18 decimals)
   */
  async buy(amount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Approve MAINTOKEN for staking contract
    await this.approveIfNeeded(this.client.mainTokenAddress, this.stakingAddress, amount);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'buy',
      args: [amount],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Unwraps wSTASIS back to STASIS, optionally converting to USDB.
   * @param shares - wSTASIS shares in wei (18 decimals)
   * @param claimUSDB - whether to convert to USDB
   * @param minUSDB - minimum USDB output in wei (18 decimals)
   */
  async sell(shares: bigint, claimUSDB: boolean = false, minUSDB: bigint = 0n) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'sell',
      args: [shares, claimUSDB, minUSDB],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Locks wSTASIS as collateral for borrowing.
   * @param shares - wSTASIS shares in wei (18 decimals)
   */
  async lock(shares: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Approve staking contract to transfer wSTASIS (the staking contract IS the wSTASIS token)
    await this.approveIfNeeded(this.stakingAddress, this.stakingAddress, shares);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'lock',
      args: [shares],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Unlocks wSTASIS collateral.
   * @param shares - wSTASIS shares in wei (18 decimals)
   */
  async unlock(shares: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'unlock',
      args: [shares],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Pledges STASIS as collateral and borrows USDB against it.
   * The stasisAmountToBorrow parameter is the STASIS amount to pledge — USDB received is collateral value minus fees.
   * @param stasisAmountToBorrow - STASIS collateral amount in wei (18 decimals)
   * @param days - integer, minimum 10
   */
  async borrow(stasisAmountToBorrow: bigint, days: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'borrow',
      args: [stasisAmountToBorrow, days],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Repays the active staking loan. Auto-approves the exact USDB debt
   * to the staking contract (read from the loan hub). Throws if the
   * caller has no active staking loan.
   */
  async repay() {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }
    const user = this.client.walletClient.account.address;

    const { hubId, loanHubAddress } = await this._getActiveStakingLoan(user);

    // Borrower-of-record on the loan hub is the staking vault itself, not the user.
    const details = await this.client.publicClient.readContract({
      address: loanHubAddress,
      abi: ALoanHubArtifact.abi,
      functionName: 'getUserLoanDetails',
      args: [this.stakingAddress, hubId],
    }) as any;
    const fullAmount = (details.fullAmount ?? details[7]) as bigint;
    if (fullAmount > 0n) {
      await this.approveIfNeeded(this.client.usdbAddress, this.stakingAddress, fullAmount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'repay',
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Extends the active staking loan. When `payInUSDB` is true, auto-approves
   * the exact extension fee (read from the ecosystem's ExtensionEligibility).
   * @param daysToAdd - integer, minimum 10 (or 0 with refinance = true)
   * @param payInUSDB - whether to pay extension fee in USDB
   * @param refinance - whether to refinance the loan
   */
  async extendLoan(daysToAdd: bigint, payInUSDB: boolean, refinance: boolean) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }
    const user = this.client.walletClient.account.address;

    if (payInUSDB) {
      const { hubId, loanHubAddress } = await this._getActiveStakingLoan(user);

      // userLoans(stakingVault, hubId) -> (ecosystem, coreLoanId, collateralToken)
      const userLoan = await this.client.publicClient.readContract({
        address: loanHubAddress,
        abi: ALoanHubArtifact.abi,
        functionName: 'userLoans',
        args: [this.stakingAddress, hubId],
      }) as readonly [Address, bigint, Address];
      const [ecosystem, coreLoanId] = userLoan;

      // Preview the exact fee the ecosystem will charge for this extension
      const eligibility = await this.client.publicClient.readContract({
        address: ecosystem,
        abi: IMainCoreArtifact.abi,
        functionName: 'ExtensionEligibility',
        args: [loanHubAddress, coreLoanId, daysToAdd, false, true, refinance],
      }) as readonly [boolean, bigint, bigint];
      const possible = eligibility[0];
      const fee = eligibility[1];
      if (!possible) throw new Error('Extension not possible under current loan state.');

      if (fee > 0n) {
        await this.approveIfNeeded(this.client.usdbAddress, this.stakingAddress, fee);
      }
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'extendLoan',
      args: [daysToAdd, payInUSDB, refinance],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Gets staking details for a user.
   * Returns [liquidShares, lockedShares, totalShares, totalAssetValue].
   */
  async getUserStakeDetails(user: Address) {
    return this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'getUserStakeDetails',
      args: [user],
    });
  }

  /**
   * Gets the available STASIS (collateral value minus pledged).
   */
  async getAvailableStasis(user: Address) {
    return this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'getAvailableStasis',
      args: [user],
    }) as Promise<bigint>;
  }

  /**
   * Converts STASIS amount to wSTASIS shares.
   * @param assets - STASIS amount in wei (18 decimals)
   */
  async convertToShares(assets: bigint) {
    return this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'convertToShares',
      args: [assets],
    }) as Promise<bigint>;
  }

  /**
   * Converts wSTASIS shares to STASIS amount.
   * @param shares - wSTASIS shares in wei (18 decimals)
   */
  async convertToAssets(shares: bigint) {
    return this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'convertToAssets',
      args: [shares],
    }) as Promise<bigint>;
  }

  /**
   * Returns total STASIS held by the vault (available + pledged).
   */
  async totalAssets(): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'totalAssets',
    }) as Promise<bigint>;
  }

  /**
   * Borrows additional STASIS against locked wSTASIS collateral on an existing loan.
   * @param additionalStasisToBorrow - STASIS collateral amount in wei (18 decimals)
   */
  async addToLoan(additionalStasisToBorrow: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'addToLoan',
      args: [additionalStasisToBorrow],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Settles a liquidated staking loan position.
   */
  async settleLiquidation() {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.stakingAddress,
      abi: AStasisVaultArtifact.abi,
      functionName: 'settleLiquidation',
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);
    return { hash, receipt };
  }
}
