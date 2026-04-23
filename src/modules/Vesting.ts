import { BasisClient } from '../BasisClient';
import AVestingArtifact from '../abis/A_VestingContract.json';
import ALoanHubArtifact from '../abis/ALOAN_HUB.json';
import IERC20Artifact from '../abis/IERC20.json';
import { Address } from 'viem';

export class VestingModule {
  private client: BasisClient;
  private vestingAddress: Address;

  constructor(client: BasisClient, vestingAddress: Address) {
    this.client = client;
    this.vestingAddress = vestingAddress;
  }

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
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

  private async getFeeAmount(): Promise<bigint> {
    try {
      const account = this.client.walletClient?.account?.address;
      const [enabled, amount, whitelisted] = await Promise.all([
        this.client.publicClient.readContract({
          address: this.vestingAddress,
          abi: AVestingArtifact.abi,
          functionName: 'feeEnabled',
        }) as Promise<boolean>,
        this.client.publicClient.readContract({
          address: this.vestingAddress,
          abi: AVestingArtifact.abi,
          functionName: 'feeAmount',
        }) as Promise<bigint>,
        account
          ? this.client.publicClient.readContract({
              address: this.vestingAddress,
              abi: AVestingArtifact.abi,
              functionName: 'feeWhitelist',
              args: [account],
            }) as Promise<boolean>
          : Promise.resolve(false),
      ]);
      if (!enabled || whitelisted) return 0n;
      return amount;
    } catch {
      return 0n;
    }
  }

  /**
   * Creates a gradual vesting schedule.
   * Auto-approves the token to the vesting contract and attaches the creation fee.
   *
   * @param totalAmount - token amount in wei (18 decimals)
   * @param startTime - Unix timestamp in seconds
   * @param durationInDays - integer, number of days
   * @param timeUnit - enum: 0=Second, 1=Minute, 2=Hour, 3=Day
   */
  async createGradualVesting(
    beneficiary: Address,
    token: Address,
    totalAmount: bigint,
    startTime: bigint,
    durationInDays: bigint,
    timeUnit: number,
    memo: string,
    ecosystem: Address
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Auto-approve token to the vesting contract
    await this.approveIfNeeded(token, this.vestingAddress, totalAmount);

    // Fetch fee
    const feeAmount = await this.getFeeAmount();

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'createGradualVesting',
      args: [beneficiary, token, totalAmount, startTime, durationInDays, timeUnit, memo, ecosystem],
      value: feeAmount,
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Creates a cliff vesting schedule.
   *
   * @param totalAmount - token amount in wei (18 decimals)
   * @param unlockTime - Unix timestamp in seconds
   */
  async createCliffVesting(
    beneficiary: Address,
    token: Address,
    totalAmount: bigint,
    unlockTime: bigint,
    memo: string,
    ecosystem: Address
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    await this.approveIfNeeded(token, this.vestingAddress, totalAmount);
    const feeAmount = await this.getFeeAmount();

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'createCliffVesting',
      args: [beneficiary, token, totalAmount, unlockTime, memo, ecosystem],
      value: feeAmount,
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Claims unlocked tokens.
   */
  async claimTokens(vestingId: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'claimTokens',
      args: [vestingId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Leverages locked tokens for a loan.
   */
  async takeLoanOnVesting(vestingId: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'takeLoanOnVesting',
      args: [vestingId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Repays a loan taken on a vesting schedule.
   *
   * Auto-approves the exact debt of the borrowed token to the vesting
   * contract. Reads `vestingSchedules(id).ecosystem` and
   * `ecosystems(maintoken).mainpair` to discover the borrow token
   * (typically USDB but ecosystem-defined), then reads the loan's
   * `fullAmount` from the loan hub. If the underlying loan is no longer
   * active (already repaid / liquidated), no approval is performed —
   * the contract handles cleanup paths without a transferFrom.
   */
  async repayLoanOnVesting(vestingId: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // 1. Find the active loan id; bail early if none.
    const activeLoanId = await this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getActiveLoan',
      args: [vestingId],
    }) as bigint;
    if (activeLoanId === 0n) {
      throw new Error('No active loan on this vesting schedule.');
    }

    // 2. Discover the borrow token via the schedule's ecosystem.
    const schedule = await this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'vestingSchedules',
      args: [vestingId],
    }) as any;
    const ecosystem = (schedule.ecosystem ?? schedule[3]) as Address;
    const eco = await this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'ecosystems',
      args: [ecosystem],
    }) as readonly [Address, Address, Address];
    const borrowedToken = eco[2]; // mainpair

    // 3. Read the actual debt from the loan hub. Borrower-of-record is
    //    the vesting contract itself, not msg.sender.
    const loanHubAddress = await this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'LOAN',
    }) as Address;
    const details = await this.client.publicClient.readContract({
      address: loanHubAddress,
      abi: ALoanHubArtifact.abi,
      functionName: 'getUserLoanDetails',
      args: [this.vestingAddress, activeLoanId],
    }) as any;
    const isActive = (details.active ?? details[12]) as boolean;
    const fullAmount = (details.fullAmount ?? details[7]) as bigint;

    // 4. Approve only if the contract will actually pull funds.
    if (isActive && fullAmount > 0n) {
      await this.approveIfNeeded(borrowedToken, this.vestingAddress, fullAmount);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'repayLoanOnVesting',
      args: [vestingId],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Gets details of a specific vesting schedule.
   */
  async getVestingDetails(vestingId: bigint) {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getVestingDetails',
      args: [vestingId],
    });
  }

  /**
   * Gets the current claimable amount for a vesting schedule.
   */
  async getClaimableAmount(vestingId: bigint) {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getClaimableAmount',
      args: [vestingId],
    });
  }

  /**
   * Creates gradual vesting schedules for multiple beneficiaries in a single transaction.
   * Auto-approves the sum of all amounts and attaches the creation fee.
   *
   * @param totalAmounts - token amounts in wei (18 decimals)
   * @param startTime - Unix timestamp in seconds
   * @param durationInDays - integer, number of days
   * @param timeUnit - enum: 0=Second, 1=Minute, 2=Hour, 3=Day
   */
  async batchCreateGradualVesting(
    beneficiaries: Address[],
    token: Address,
    totalAmounts: bigint[],
    userMemos: string[],
    startTime: bigint,
    durationInDays: bigint,
    timeUnit: number,
    ecosystem: Address
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Sum all amounts for approval
    const totalApproval = totalAmounts.reduce((sum, amt) => sum + amt, 0n);
    await this.approveIfNeeded(token, this.vestingAddress, totalApproval);

    const feeAmount = await this.getFeeAmount();

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'batchCreateGradualVesting',
      args: [beneficiaries, token, totalAmounts, userMemos, startTime, durationInDays, timeUnit, ecosystem],
      value: feeAmount,
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Creates cliff vesting schedules for multiple beneficiaries in a single transaction.
   * Auto-approves the sum of all amounts and attaches the creation fee.
   *
   * @param totalAmounts - token amounts in wei (18 decimals)
   * @param unlockTime - Unix timestamp in seconds
   */
  async batchCreateCliffVesting(
    beneficiaries: Address[],
    token: Address,
    totalAmounts: bigint[],
    unlockTime: bigint,
    userMemos: string[],
    ecosystem: Address
  ) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const totalApproval = totalAmounts.reduce((sum, amt) => sum + amt, 0n);
    await this.approveIfNeeded(token, this.vestingAddress, totalApproval);

    const feeAmount = await this.getFeeAmount();

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'batchCreateCliffVesting',
      args: [beneficiaries, token, totalAmounts, unlockTime, userMemos, ecosystem],
      value: feeAmount,
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Changes the beneficiary of a vesting schedule.
   */
  async changeBeneficiary(vestingId: bigint, newBeneficiary: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'changeBeneficiary',
      args: [vestingId, newBeneficiary],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Extends the vesting period by additional days.
   *
   * @param additionalDays - integer, number of days
   */
  async extendVestingPeriod(vestingId: bigint, additionalDays: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'extendVestingPeriod',
      args: [vestingId, additionalDays],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Adds more tokens to an existing vesting schedule.
   * Auto-approves the token to the vesting contract.
   *
   * @param additionalAmount - token amount in wei (18 decimals)
   */
  async addTokensToVesting(vestingId: bigint, additionalAmount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    // Read vesting details to get the token address
    const details = await this.getVestingDetails(vestingId) as any;
    const token = details.token ?? details[2];
    await this.approveIfNeeded(token, this.vestingAddress, additionalAmount);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'addTokensToVesting',
      args: [vestingId, additionalAmount],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Transfers the creator role of a vesting schedule to a new address.
   */
  async transferCreatorRole(vestingId: bigint, newCreator: Address) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error("Stateful initialization (walletClient) is required for write methods.");
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'transferCreatorRole',
      args: [vestingId, newCreator],
    });

    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });

    await this._syncTx(hash);

    return { hash, receipt };
  }

  /**
   * Returns all vesting IDs for a given beneficiary.
   */
  async getVestingsByBeneficiary(beneficiary: Address): Promise<bigint[]> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getVestingsByBeneficiary',
      args: [beneficiary],
    }) as Promise<bigint[]>;
  }

  /**
   * Returns the total vested amount for a vesting schedule.
   */
  async getVestedAmount(vestingId: bigint): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getVestedAmount',
      args: [vestingId],
    }) as Promise<bigint>;
  }

  /**
   * Returns the active loan ID for a vesting schedule.
   */
  async getActiveLoan(vestingId: bigint): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getActiveLoan',
      args: [vestingId],
    }) as Promise<bigint>;
  }

  /**
   * Returns vesting IDs for a given token within a specified index range.
   *
   * @param startIndex - array index
   * @param endIndex - array index
   */
  async getTokenVestingIds(token: Address, startIndex: bigint, endIndex: bigint): Promise<bigint[]> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getTokenVestingIds',
      args: [token, startIndex, endIndex],
    }) as Promise<bigint[]>;
  }

  /**
   * Returns vesting details for multiple vesting IDs in a single call.
   */
  async getVestingDetailsBatch(vestingIds: bigint[]) {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getVestingDetailsBatch',
      args: [vestingIds],
    });
  }

  /**
   * Returns the total number of vesting schedules created.
   */
  async getVestingCount(): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'vestingCount',
    }) as Promise<bigint>;
  }

  /**
   * Returns all vesting IDs created by a given creator.
   */
  async getVestingsByCreator(creator: Address): Promise<bigint[]> {
    return this.client.publicClient.readContract({
      address: this.vestingAddress,
      abi: AVestingArtifact.abi,
      functionName: 'getVestingsByCreator',
      args: [creator],
    }) as Promise<bigint[]>;
  }
}
